import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';

test('Esquema PostgreSQL: permisos, identificadores y conflictos',async t => {
  const db = new PGlite();
  const users = [randomUUID(),randomUUID(),randomUUID(),randomUUID()];
  const photo = (user,id) => `${user}/${id}/${'a'.repeat(64)}.jpg`;
  const values = {category:'Máquina de escribir',brand:'Olivetti',model:'Lettera 22',manufacture_date:'ca. 1950',type:'Portátil',destination:'museo',notes:''};
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create schema storage;
      create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;
      $$;
      create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      create table storage.objects(bucket_id text,name text,primary key(bucket_id,name));
      alter table storage.objects enable row level security;
      create function storage.foldername(text) returns text[] language sql immutable as $$ select string_to_array($1,'/'); $$;
      grant usage on schema public,auth,storage to anon,authenticated;
      grant select,insert,delete on storage.objects to anon,authenticated;
      alter default privileges in schema public grant all on tables to anon,authenticated;
    `);
    await db.exec(await readFile(new URL('../supabase/migrations/202610280001_inventory.sql',import.meta.url),'utf8'));
    for (const [index,user] of users.entries()) {
      await db.query('insert into auth.users values ($1)',[user]);
      if (index < 3) await db.query('insert into public.inventory_members values ($1,$2)',[user,`Persona ${index+1}`]);
    }
    await db.exec(await readFile(new URL('../supabase/migrations/202610280002_usernames.sql',import.meta.url),'utf8'));
    await db.exec(await readFile(new URL('../supabase/migrations/202610280004_delete_items.sql',import.meta.url),'utf8'));
    for (const [index,username] of ['aleProdigo','franProdigo','maxiProdigo'].entries()) {
      await db.query('update public.inventory_members set username=$1 where user_id=$2',[username,users[index]]);
    }
    async function as(user,role = 'authenticated') {
      await db.exec('reset role');
      await db.query("select set_config('request.jwt.claim.sub',$1,false)",[user || '']);
      await db.exec(`set role ${role}`);
    }
    async function upload(user,id) {
      const path = photo(user,id);
      await db.query("insert into storage.objects values ('inventory-photos',$1)",[path]);
      return path;
    }
    const save = (id,revision,v,path) => db.query('select * from public.save_inventory_item($1,$2,$3::jsonb,$4)',[id,revision,JSON.stringify(v),path]);
    const remove = (id,revision) => db.query('select public.delete_inventory_item($1,$2) as photo_path',[id,revision]);
    let first;
    await t.test('Sin sesión no se pueden leer fichas ni invocar el guardado',async () => {
      await as(null,'anon');
      await assert.rejects(db.query('select * from public.inventory_items'),/permission denied/);
      await assert.rejects(save(randomUUID(),0,values,'x'),/permission denied/);
    });
    await t.test('Una cuenta no habilitada no puede darse acceso ni leer o guardar',async () => {
      await as(users[3]);
      await assert.rejects(db.query('insert into public.inventory_members values ($1,\'Intruso\')',[users[3]]),/permission denied/);
      assert.equal((await db.query('select * from public.inventory_items')).rows.length,0);
      assert.equal((await db.query('select * from public.inventory_terms')).rows.length,0);
      await assert.rejects(save(randomUUID(),0,values,'x'),/No tenés acceso/);
      await assert.rejects(db.query("select public.inventory_term('category','','','Intrusión')"),/permission denied/);
    });
    await t.test('Los tres nombres son únicos sin distinguir mayúsculas y no se publican',async () => {
      await as(users[0]);
      const own = (await db.query('select username from public.inventory_members')).rows;
      assert.deepEqual(own,[{username:'aleProdigo'}]);
      await assert.rejects(db.query("update public.inventory_members set username='maxiProdigo'"),/permission denied/);
      await as(null,'anon');
      await assert.rejects(db.query('select username from public.inventory_members'),/permission denied/);
      await db.exec('reset role');
      await assert.rejects(db.query("update public.inventory_members set username='ALEPRODIGO' where user_id=$1",[users[1]]),/duplicate key/);
      await assert.rejects(db.query("update public.inventory_members set username='Fran Prodigo' where user_id=$1",[users[1]]),/check constraint/);
    });
    await t.test('Tres integrantes obtienen números P de seis cifras distintos',async () => {
      const codes = [];
      for (const user of users.slice(0,3)) {
        await as(user); const id = randomUUID(); const path = await upload(user,id);
        const item = (await save(id,0,values,path)).rows[0]; codes.push(item.code); first ||= item;
      }
      assert.deepEqual(codes,['P000001','P000002','P000003']);
      assert.equal((await db.query('select * from public.inventory_items')).rows.length,3);
    });
    await t.test('Reintentar la misma alta no crea otra ficha ni consume otro número',async () => {
      await as(users[0]);
      const replay = (await save(first.id,0,values,first.photo_path)).rows[0];
      assert.equal(replay.code,first.code); assert.equal(replay.revision,1);
      await assert.rejects(save(first.id,0,{...values,notes:'cambio después del intento'},first.photo_path),/ya fue guardada/);
      assert.equal((await db.query('select * from public.inventory_items')).rows.length,3);
    });
    await t.test('Edición compartida: conserva el identificador y rechaza revisión antigua',async () => {
      await as(users[1]);
      const edited = (await save(first.id,1,{...values,destination:'tienda'},first.photo_path)).rows[0];
      assert.equal(edited.code,'P000001'); assert.equal(edited.revision,2); assert.equal(edited.updated_by,users[1]);
      await as(users[2]);
      await assert.rejects(save(first.id,1,{...values,notes:'edición vieja'},first.photo_path),/Otra persona modificó/);
      await assert.rejects(db.query("update public.inventory_items set notes = 'alteración directa' where id=$1",[first.id]),/permission denied/);
    });
    await t.test('Nuevos objetos sin marca/modelo y tipos propios; vocabularios compartidos',async () => {
      await as(users[0]); const id = randomUUID(); const path = await upload(users[0],id);
      const item = (await save(id,0,{...values,category:'Radio',brand:'',model:'',type:'A válvulas'},path)).rows[0];
      assert.equal(item.code,'P000004'); assert.equal(item.brand,'');
      const terms = (await db.query("select * from public.inventory_terms where category='Radio'")).rows;
      assert.deepEqual(terms.map(t => t.name),['A válvulas']);
      assert.equal((await db.query("select * from public.inventory_terms where kind='category' and name='Radio'")).rows.length,1);
      assert.equal((await db.query("select * from public.inventory_terms where kind='model' and parent_name='Olivetti'")).rows.length,1);
    });
    await t.test('Exige foto propia para las altas, destino válido y marca antes de modelo',async () => {
      await as(users[0]);
      await assert.rejects(save(randomUUID(),0,values,first.photo_path),/foto válida/);
      await assert.rejects(save(randomUUID(),0,{...values,destination:'casa'},'x'),/Elegí un destino/);
      await assert.rejects(save(randomUUID(),0,{...values,brand:''},'x'),/marca antes/);
      await assert.rejects(upload(users[1],randomUUID()),/row-level security/);
    });
    await t.test('Las fotos son privadas y una foto vinculada no se puede borrar',async () => {
      await as(users[3]); assert.equal((await db.query('select * from storage.objects')).rows.length,0);
      await as(users[0]);
      const removed = await db.query('delete from storage.objects where name=$1 returning *',[first.photo_path]);
      assert.equal(removed.rows.length,0);
      const id = randomUUID(), path = await upload(users[0],id);
      assert.equal((await db.query('delete from storage.objects where name=$1 returning *',[path])).rows.length,1);
    });
    await t.test('El borrado exige membresía y revisión válida; impide borrar directamente las tablas',async () => {
      await as(null,'anon'); await assert.rejects(remove(first.id,2),/permission denied/);
      await as(users[3]); await assert.rejects(remove(first.id,2),/No tenés acceso/);
      await as(users[0]);
      await assert.rejects(remove(first.id,0),/revisión inválidos/);
      await assert.rejects(remove(null,2),/revisión inválidos/);
      await assert.rejects(db.query('delete from public.inventory_items where id=$1',[first.id]),/permission denied/);
    });
    await t.test('No borra una edición reciente; otro integrante puede borrar la revisión actual y limpiar su foto',async () => {
      await as(users[2]);
      await assert.rejects(remove(first.id,1),/Otra persona modificó/);
      assert.equal((await db.query('select id from public.inventory_items where id=$1',[first.id])).rows.length,1);
      assert.equal((await remove(first.id,2)).rows[0].photo_path,first.photo_path);
      assert.equal((await db.query('select id from public.inventory_items where id=$1',[first.id])).rows.length,0);
      assert.equal((await db.query('delete from storage.objects where name=$1 returning *',[first.photo_path])).rows.length,1);
      assert.equal((await remove(first.id,2)).rows[0].photo_path,null);
      await assert.rejects(save(first.id,2,values,first.photo_path),/ya no está disponible/);
    });
    await t.test('Los identificadores borrados no se reciclan y los vocabularios se conservan',async () => {
      await as(users[0]); const id = randomUUID(); const path = await upload(users[0],id);
      const saved = (await save(id,0,{...values,manufacture_date:'15/06/1950'},path)).rows[0];
      assert.equal(saved.code,'P000005'); assert.equal(saved.manufacture_date,'15/06/1950');
      assert.equal((await db.query("select name from public.inventory_terms where kind='brand' and name='Olivetti'")).rows.length,1);
    });
    await t.test('La numeración original se guarda como texto y sobrevive a ediciones desde una versión anterior',async () => {
      await db.exec('reset role');
      const migration = await readFile(new URL('../supabase/migrations/202610280005_original_number.sql',import.meta.url),'utf8');
      await db.exec(migration);
      await as(users[0]);
      const existing = (await db.query("select * from public.inventory_items where code='P000005'")).rows[0];
      assert.equal(existing.original_number,'');
      const edited = (await save(existing.id,existing.revision,{...values,original_number:'  000127-A  '},existing.photo_path)).rows[0];
      assert.equal(edited.original_number,'000127-A');
      assert.equal(edited.code,existing.code);
      const fromOldClient = (await save(edited.id,edited.revision,{...values,notes:'Revisado'},edited.photo_path)).rows[0];
      assert.equal(fromOldClient.original_number,'000127-A');
      const cleared = (await save(edited.id,fromOldClient.revision,{...values,original_number:''},edited.photo_path)).rows[0];
      assert.equal(cleared.original_number,'');
      await assert.rejects(save(edited.id,cleared.revision,{...values,original_number:'0'.repeat(121)},edited.photo_path),/120 caracteres/);

      const id = randomUUID(), path = await upload(users[0],id);
      const numbered = {...values,original_number:'000458'};
      const created = (await save(id,0,numbered,path)).rows[0];
      assert.equal(created.original_number,'000458');
      assert.equal((await save(id,0,numbered,path)).rows[0].code,created.code);
      await assert.rejects(save(id,0,{...numbered,original_number:'000459'},path),/ya fue guardada/);
    });
    await t.test('El recorte se edita por revisión y se mantiene asociado a su foto',async () => {
      await db.exec('reset role');
      await db.exec(await readFile(new URL('../supabase/migrations/202610280006_photo_crop.sql',import.meta.url),'utf8'));
      await as(users[0]);
      const id = randomUUID(), path = await upload(users[0],id);
      const crop = [.1,.2,.3,.4];
      const input = {...values,original_number:'000127',photo_crop:crop};
      const created = (await save(id,0,input,path)).rows[0];
      assert.deepEqual(created.photo_crop,crop);
      assert.equal((await save(id,0,input,path)).rows[0].code,created.code);
      await assert.rejects(save(id,0,{...input,photo_crop:null},path),/ya fue guardada/);
      await assert.rejects(save(id,1,{...input,photo_crop:[.9,0,.5,.5]},path),/check constraint/);
      const oldClient = (await save(id,1,{...values,notes:'Revisado'},path)).rows[0];
      assert.deepEqual(oldClient.photo_crop,crop);
      assert.equal(oldClient.original_number,'000127');
      const cleared = (await save(id,2,{...values,photo_crop:null},path)).rows[0];
      assert.equal(cleared.photo_crop,null);
      const edited = (await save(id,3,input,path)).rows[0];
      assert.equal(edited.photo_path,path);
      assert.deepEqual(edited.photo_crop,crop);
      await as(users[1]);
      const replacement = await upload(users[1],id);
      const replaced = (await save(id,edited.revision,values,replacement)).rows[0];
      assert.equal(replaced.photo_crop,null);
    });
    await t.test('La galería pertenece a su ficha y protege las fotos vinculadas',async () => {
      await db.exec('reset role');
      await db.exec(await readFile(new URL('../supabase/migrations/202610280007_extra_photos.sql',import.meta.url),'utf8'));
      await as(users[0]);
      const id = randomUUID(), cover = await upload(users[0],id);
      const extra = `${users[0]}/${id}/${'b'.repeat(64)}.jpg`;
      await db.query("insert into storage.objects values ('inventory-photos',$1)",[extra]);
      const foreign = await upload(users[0],randomUUID());
      await assert.rejects(save(id,0,{...values,extra_photos:[foreign]},cover),/fotos válidas/);
      const withGallery = {...values,extra_photos:[extra]};
      const created = (await save(id,0,withGallery,cover)).rows[0];
      assert.deepEqual(created.extra_photos,[extra]);
      assert.equal((await save(id,0,withGallery,cover)).rows[0].code,created.code);
      await as(users[1]);
      const legacyEdit = (await save(id,1,{...values,notes:'Revisado'},cover)).rows[0];
      assert.deepEqual(legacyEdit.extra_photos,[extra]);
      const clean = () => db.query('delete from storage.objects where name=$1 returning name',[extra]);
      assert.equal((await clean()).rows.length,0);
      await save(id,2,{...values,extra_photos:[]},cover);
      assert.equal((await clean()).rows.length,1);
    });
    await t.test('Otro integrante puede intercambiar portada y adicional sin volver a subir los archivos',async () => {
      await db.exec('reset role');
      await db.exec(await readFile(new URL('../supabase/migrations/202610280008_choose_cover.sql',import.meta.url),'utf8'));
      await as(users[0]);
      const id = randomUUID(), cover = await upload(users[0],id);
      const extra = `${users[0]}/${id}/${'c'.repeat(64)}.jpg`;
      await db.query("insert into storage.objects values ('inventory-photos',$1)",[extra]);
      const created = (await save(id,0,{...values,photo_crop:[0,0,.5,.5],extra_photos:[extra]},cover)).rows[0];
      await as(users[1]);
      const promoted = (await save(id,1,{...values,photo_crop:null,extra_photos:[cover]},extra)).rows[0];
      assert.equal(promoted.code,created.code);
      assert.equal(promoted.photo_path,extra);
      assert.deepEqual(promoted.extra_photos,[cover]);
      assert.equal(promoted.photo_crop,null);
      assert.equal((await db.query('delete from storage.objects where name=$1 returning name',[cover])).rows.length,0);
      await assert.rejects(save(id,1,{...values,extra_photos:[extra]},cover),/Otra persona modificó/);
      const restored = (await save(id,2,{...values,extra_photos:[extra]},cover)).rows[0];
      assert.equal(restored.photo_path,cover);
      assert.deepEqual(restored.extra_photos,[extra]);
      await assert.rejects(save(id,3,values,first.photo_path),/foto válida/);
    });
  } finally { await db.close(); }
});
