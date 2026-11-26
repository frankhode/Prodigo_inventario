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

    await t.test('Etiqueta física, historial y anulación sin reutilizar números',async () => {
      await db.exec('reset role');
      await db.exec(await readFile(new URL('../supabase/migrations/202611160001_labeling_audit.sql',import.meta.url),'utf8'));
      await as(users[0]);
      const original = (await db.query("select * from public.inventory_items where code='P000005'")).rows[0];
      assert.equal(original.label_confirmed_at,null);
      const label = (id,revision,labeled) => db.query(
        'select * from public.set_inventory_label($1,$2,$3)',[id,revision,labeled]
      );
      const voidItem = (id,revision,reason) => db.query(
        'select public.void_inventory_item($1,$2,$3) as photo_path',[id,revision,reason]
      );
      await as(users[3]);
      await assert.rejects(label(original.id,original.revision,true),/No tenés acceso/);
      assert.equal((await db.query('select * from public.inventory_number_voids')).rows.length,0);
      await as(users[0]);
      await assert.rejects(label(original.id,original.revision-1,true),/Otra persona modificó/);
      const done = (await label(original.id,original.revision,true)).rows[0];
      assert.equal(done.label_confirmed_by,users[0]);
      assert.ok(done.label_confirmed_at);
      assert.equal(done.revision,original.revision+1);
      assert.equal((await label(done.id,done.revision,true)).rows[0].revision,done.revision);
      const events = (await db.query('select labeled from public.inventory_label_events where item_id=$1',[done.id])).rows;
      assert.deepEqual(events.map(event=>event.labeled),[true]);
      await as(users[1]);
      await assert.rejects(label(done.id,original.revision,false),/Otra persona modificó/);
      const undone = (await label(done.id,done.revision,false)).rows[0];
      assert.equal(undone.label_confirmed_at,null);
      assert.equal(undone.label_confirmed_by,null);
      assert.equal((await db.query('select * from public.inventory_label_events where item_id=$1',[done.id])).rows.length,2);
      const redone = (await label(done.id,undone.revision,true)).rows[0];
      await assert.rejects(voidItem(redone.id,redone.revision,'no'),/motivo de anulación/);
      await assert.rejects(voidItem(redone.id,undone.revision,'Registro duplicado'),/Otra persona modificó/);
      const removed = (await voidItem(redone.id,redone.revision,'Registro duplicado')).rows[0];
      assert.equal(removed.photo_path,redone.photo_path);
      assert.equal((await db.query('select id from public.inventory_items where id=$1',[done.id])).rows.length,0);
      const tombstone = (await db.query('select * from public.inventory_number_voids where number=$1',[done.number])).rows[0];
      assert.equal(tombstone.code,done.code);
      assert.equal(tombstone.reason,'Registro duplicado');
      assert.equal(tombstone.voided_by,users[1]);
      assert.equal(tombstone.snapshot.label_confirmed_by,users[1]);
      assert.equal((await voidItem(done.id,redone.revision,'Registro duplicado')).rows[0].photo_path,null);
      await assert.rejects(db.query('insert into public.inventory_number_voids(number,item_id,snapshot,reason,voided_by) values ($1,$2,$3,$4,$5)',[999999,randomUUID(),'{}','Intrusión',users[0]]),/permission denied/);
      await as(users[3]);
      assert.equal((await db.query('select * from public.inventory_number_voids')).rows.length,0);
      await as(users[0]);
      const id = randomUUID(), path = await upload(users[0],id);
      const next = (await save(id,0,values,path)).rows[0];
      assert.ok(next.number > done.number);
      assert.equal((await db.query('select * from public.inventory_number_voids where number=$1',[done.number])).rows.length,1);
    });

    await t.test('Reserva un rango único y etiqueta fotografías en cualquier orden físico',async () => {
      await db.exec('reset role');
      await db.exec(await readFile(new URL('../supabase/migrations/202611160002_bulk_batches.sql',import.meta.url),'utf8'));
      const seq=await db.query('select last_value,is_called from public.inventory_items_number_seq');
      const start=Number(seq.rows[0].last_value)+(seq.rows[0].is_called ? 1 : 0);
      await as(users[0]);
      const ids=[randomUUID(),randomUUID(),randomUUID()];
      const paths=[];
      for (const id of ids) paths.push(await upload(users[0],id));
      const pics=ids.map((id,index)=>({
        id,original_filename:`digital/imagen_${index+1}.jpg`,photo_path:paths[index],
        image_values:index===1?{manufacture_date:'1906'}:{}
      }));
      const common={category:'Fotografía',destination:'museo',brand:'',model:'',
        manufacture_date:'',type:'Retrato',notes:''};
      const reserve=(id,expected,files=pics) => db.query(
        'select * from public.create_inventory_bulk_batch($1,$2,$3::jsonb,$4::jsonb)',
        [id,expected,JSON.stringify(common),JSON.stringify(files)]
      );
      const batchId=randomUUID();
      await assert.rejects(reserve(batchId,start+1),/próxima etiqueta debe ser/);
      await db.exec('reset role');
      const unchanged=await db.query('select last_value,is_called from public.inventory_items_number_seq');
      assert.deepEqual(unchanged.rows,seq.rows);
      await as(users[0]);
      const batch=(await reserve(batchId,start)).rows[0];
      assert.equal(batch.total,3);
      assert.equal(Number(batch.start_number),start);
      assert.equal(Number(batch.end_number),start+2);
      assert.equal((await reserve(batchId,start)).rows[0].id,batchId);
      const pending=(await db.query('select * from public.inventory_bulk_slots where batch_id=$1 order by ordinal',[batchId])).rows;
      assert.deepEqual(pending.map(x=>Number(x.number)),[start,start+1,start+2]);
      assert.ok(pending.every(x=>!x.image_id));
      assert.equal((await db.query('select * from public.inventory_items where number between $1 and $2',[start,start+2])).rows.length,0);
      const assign=(actorIndex,imgIndex,expected,details={})=>db.query(
        'select * from public.assign_inventory_bulk_image($1,$2,$3,$4::jsonb)',
        [batchId,ids[imgIndex],expected,JSON.stringify(details)]
      );
      await as(users[3]);
      await assert.rejects(assign(3,1,start),/No tenés acceso/);
      assert.equal((await db.query('select * from public.inventory_bulk_batches')).rows.length,0);
      await as(users[1]);
      const second=(await assign(1,1,start,{original_number:'000127'})).rows[0];
      assert.equal(second.id,ids[1]);assert.equal(second.code,`P${String(start).padStart(6,'0')}`);
      assert.equal(second.manufacture_date,'1906');assert.equal(second.original_number,'000127');
      assert.equal(second.label_confirmed_at,null);assert.equal(second.label_confirmed_by,null);
      assert.equal((await assign(1,1,start,{original_number:'999'})).rows[0].original_number,'000127');
      await assert.rejects(assign(1,0,start),/próxima etiqueta física/);
      const first=(await assign(1,0,start+1)).rows[0];
      assert.equal(first.id,ids[0]);assert.equal(Number(first.number),start+1);
      const third=(await assign(1,2,start+2,{notes:'Identificada en la caja física'})).rows[0];
      assert.equal(third.id,ids[2]);assert.equal(third.notes,'Identificada en la caja física');
      await assert.rejects(assign(1,0,start+2),/otro número asociado/);
      assert.equal((await db.query('select * from public.inventory_label_events where item_id = any($1::uuid[])',[ids])).rows.length,0);
      for(const item of [second,first,third]) {
        const confirmed=(await db.query('select * from public.set_inventory_label($1,$2,$3)',[item.id,item.revision,true])).rows[0];
        assert.ok(confirmed.label_confirmed_at);
        assert.equal(confirmed.label_confirmed_by,users[1]);
      }
      assert.equal((await db.query('select * from public.inventory_label_events where item_id = any($1::uuid[])',[ids])).rows.length,3);
      assert.equal((await db.query('select * from public.inventory_bulk_slots where image_id is not null and batch_id=$1',[batchId])).rows.length,3);
      await as(users[0]); const id=randomUUID(),path=await upload(users[0],id);
      const regular=(await save(id,0,values,path)).rows[0];
      assert.equal(Number(regular.number),start+3);
    });

    await t.test('Importación del catalogador conserva procedencia, reversos y evita duplicaciones',async () => {
      await db.exec('reset role');
      await db.exec(await readFile(new URL('../supabase/migrations/202611160003_catalog_import.sql',import.meta.url),'utf8'));
      const seq=await db.query('select last_value,is_called from public.inventory_items_number_seq');
      const start=Number(seq.rows[0].last_value)+(seq.rows[0].is_called?1:0);
      await as(users[0]);
      const id=randomUUID(),cover=await upload(users[0],id);
      const extraPath=`${users[0]}/${id}/${'b'.repeat(64)}.jpg`;
      await db.query("insert into storage.objects values ('inventory-photos',$1)",[extraPath]);
      const sourceKey=`prodigo-catalogador:bixio:${'a'.repeat(64)}`;
      const source={system:'prodigo-catalogador',collection_id:'bixio',collection_name:'F. Bixio y Cia.',
        source_id:'a'.repeat(64),original_filename:'img024.tif',
        record:{number:'000127',date:'ca. 1900',signature:'BIX-01',people:['Niñas'],color:'byn'},
        parts:[{id:'b'.repeat(64),original_filename:'img024b.tif',record:{side:'Reverso',notes:'Nota al dorso'}}]};
      const input={
        id,original_filename:'img024.tif',photo_path:cover,extra_photos:[extraPath],
        source_key:sourceKey,source_data:source,
        image_values:{original_number:'000127',manufacture_date:'ca. 1900',
          brand:'Florencio Bixio',type:'Retrato'}
      };
      const reserve=(batchId,expected,items)=>db.query(
        'select * from public.create_inventory_bulk_batch($1,$2,$3::jsonb,$4::jsonb)',
        [batchId,expected,JSON.stringify({category:'Fotografía',destination:'museo'}),JSON.stringify(items)]
      );
      const batchId=randomUUID();
      await as(users[3]);
      await assert.rejects(reserve(batchId,start,[input]),/No tenés acceso/);
      assert.equal((await db.query('select * from public.inventory_bulk_images')).rows.length,0);
      await as(users[0]);
      await assert.rejects(reserve(randomUUID(),start,[{...input,extra_photos:[cover]}]),/complementaria inválida/);
      await reserve(batchId,start,[input]);
      const pending=(await db.query('select * from public.inventory_bulk_images where id=$1',[id])).rows[0];
      assert.deepEqual(pending.extra_photos,[extraPath]);
      assert.equal(pending.source_key,sourceKey);
      assert.equal(pending.source_data.record.number,'000127');
      assert.equal((await db.query('delete from storage.objects where name=$1 returning *',[extraPath])).rows.length,0);
      await assert.rejects(reserve(randomUUID(),start+1,[{...input,id:randomUUID()}]),/fotografía ya está incorporada|Imagen 1 sin archivo/);
      const item=(await db.query(
        'select * from public.assign_inventory_bulk_image($1,$2,$3,$4::jsonb)',
        [batchId,id,start,JSON.stringify({notes:'Inventario físico'})])).rows[0];
      assert.equal(item.original_number,'000127');
      assert.equal(item.brand,'Florencio Bixio');
      assert.equal(item.manufacture_date,'ca. 1900');
      assert.equal(item.notes,'Inventario físico');
      assert.deepEqual(item.extra_photos,[extraPath]);
      assert.equal(item.catalog_source.record.signature,'BIX-01');
      assert.equal(item.catalog_source.parts[0].record.notes,'Nota al dorso');
      assert.equal(item.label_confirmed_at,null);
      assert.equal((await db.query('delete from storage.objects where name=$1 returning *',[extraPath])).rows.length,0);
      const updated=(await save(id,item.revision,{...values,category:'Fotografía',brand:'Florencio Bixio',model:'',
        original_number:'000127',type:'Retrato'},cover)).rows[0];
      assert.deepEqual(updated.extra_photos,[extraPath]);
      assert.equal(updated.catalog_source.source_id,'a'.repeat(64));
      assert.equal(updated.catalog_source.record.number,'000127');
      const label=(await db.query('select * from public.set_inventory_label($1,$2,$3)',
        [id,updated.revision,true])).rows[0];
      assert.ok(label.label_confirmed_at);
      await assert.rejects(reserve(randomUUID(),start+1,[input]),/fotografía ya está incorporada/);
      await as(users[1]);
      const deleted=(await db.query('select public.void_inventory_item($1,$2,$3)',
        [id,label.revision,'Retirado de la colección de prueba'])).rows[0];
      assert.equal(deleted.void_inventory_item,cover);
      const voided=(await db.query('select snapshot from public.inventory_number_voids where number=$1',[start])).rows[0];
      assert.equal(voided.snapshot.catalog_source.collection_id,'bixio');
      assert.deepEqual(voided.snapshot.extra_photos,[extraPath]);
    });

    await t.test('Rangos independientes: máquinas continúan, fotografías desde P001000',async()=>{
      await db.exec('reset role');
      await db.exec(await readFile(new URL('../supabase/migrations/202611160004_number_pools.sql',import.meta.url),'utf8'));
      await as(users[0]);
      const next=category=>db.query('select public.next_inventory_number($1) as next',[category]);
      const machineBefore=Number((await next('Máquina de escribir')).rows[0].next);
      assert.ok(machineBefore>=1&&machineBefore<1000);
      assert.equal(Number((await next('Fotografía')).rows[0].next),1000);
      const photoId=randomUUID(),photoPath=await upload(users[0],photoId);
      const photoValues={...values,category:'Fotografía',brand:'F. Bixio',model:'',type:'Retrato',original_number:'000127'};
      const photoSaved=(await save(photoId,0,photoValues,photoPath)).rows[0];
      assert.equal(photoSaved.code,'P001000');
      assert.equal(Number((await next('Máquina de escribir')).rows[0].next),machineBefore);
      assert.equal(Number((await next('Fotografía')).rows[0].next),1001);
      const ids=[randomUUID(),randomUUID()];
      const images=[];
      for(const id of ids)images.push({id,original_filename:id+'.jpg',photo_path:await upload(users[0],id)});
      const batchId=randomUUID();
      const common=JSON.stringify({category:'Fotografía',destination:'museo'});
      const reserve=(expected)=>db.query(
        'select * from public.create_inventory_bulk_batch($1,$2,$3::jsonb,$4::jsonb)',
        [batchId,expected,common,JSON.stringify(images)]
      );
      await assert.rejects(reserve(machineBefore),/La próxima etiqueta para fotografías/);
      assert.equal(Number((await next('Fotografía')).rows[0].next),1001);
      const batch=(await reserve(1001)).rows[0];
      assert.equal(Number(batch.start_number),1001);
      assert.equal(Number(batch.end_number),1002);
      const slots=(await db.query('select number from public.inventory_bulk_slots where batch_id=$1 order by ordinal',[batchId])).rows;
      assert.deepEqual(slots.map(x=>Number(x.number)),[1001,1002]);
      await as(users[1]);
      const machineId=randomUUID(),machinePath=await upload(users[1],machineId);
      const machine=(await save(machineId,0,values,machinePath)).rows[0];
      assert.equal(Number(machine.number),machineBefore);
      assert.equal(Number((await next('Fotografía')).rows[0].next),1003);
      await as(users[0]);
      const afterId=randomUUID(),afterPath=await upload(users[0],afterId);
      const more=(await save(afterId,0,photoValues,afterPath)).rows[0];
      assert.equal(more.code,'P001003');
      assert.equal(Number((await next('Máquina de escribir')).rows[0].next),machineBefore+1);
      await as(users[3]);
      await assert.rejects(next('Fotografía'),/No tenés acceso/);
    });
    await t.test('Carga asistida conserva datos por material y permite omitir foto, marca y destino',async () => {
      await db.exec('reset role');
      for (const migration of ['202611250002_unlimited_gallery','202611260001_guided_intake']) {
        await db.exec(await readFile(new URL(`../supabase/migrations/${migration}.sql`,import.meta.url),'utf8'));
      }
      await as(users[0]);
      const id = randomUUID();
      const v = {...values,category:'Libro',brand:'',model:'',destination:'',
        guided_details:{group:'Material bibliográfico',fields:{Título:'Manual de prueba'}}};
      const saved = (await save(id,0,v,null)).rows[0];
      assert.equal(saved.code,'P001004');
      assert.equal(saved.photo_path,null);
      assert.equal(saved.destination,null);
      assert.deepEqual(saved.guided_details,v.guided_details);
      assert.equal((await save(id,0,v,null)).rows[0].id,id);
      await assert.rejects(save(id,0,{...v,guided_details:{...v.guided_details,fields:{}}},null),/ya fue guardada/);
      const path = await upload(users[0],id);
      const edited = (await save(id,1,{...v,destination:'museo'},path)).rows[0];
      assert.equal(edited.photo_path,path);
      assert.equal(edited.destination,'museo');
      const machineId = randomUUID();
      const machine = (await save(machineId,0,{...values,brand:'',guided_details:{group:'Oficina',fields:{}}},null)).rows[0];
      assert.equal(machine.model,values.model);
      const machineEdited=(await save(machineId,1,{...values,type:'Segunda serie',guided_details:{group:'Oficina',fields:{Tipo:'Portátil','Idioma del teclado':'Español','Distribución del teclado':'QWERTY'}}},null)).rows[0];
      assert.equal(machineEdited.type,'Segunda serie');
      assert.equal(machineEdited.guided_details.fields.Tipo,'Portátil');
      assert.equal(machineEdited.guided_details.fields['Distribución del teclado'],'QWERTY');
      assert.ok(Number(machine.number)<1000);
      assert.deepEqual((await db.query('select guided_details from public.inventory_items where id=$1',[id])).rows[0].guided_details,v.guided_details);
    });
    await t.test('La reparación permite guardar más de siete fotos adicionales',async () => {
      await db.exec('reset role');
      await db.exec('alter table public.inventory_items add constraint inventory_items_extra_photos_check check (cardinality(extra_photos) <= 7) not valid');
      const repair=await readFile(new URL('../supabase/migrations/202611260002_restore_unlimited_gallery.sql',import.meta.url),'utf8');
      await db.exec(repair);
      await db.exec(repair);
      await as(users[0]);
      const id=randomUUID(),cover=await upload(users[0],id),extra=[];
      for (let i=0;i<9;i++) {
        const path=`${users[0]}/${id}/${String(i).padStart(64,'0')}.jpg`;
        await db.query("insert into storage.objects values ('inventory-photos',$1)",[path]);
        extra.push(path);
      }
      const result=(await save(id,0,{...values,extra_photos:extra},cover)).rows[0];
      assert.deepEqual(result.extra_photos,extra);
    });
  } finally { await db.close(); }
});
