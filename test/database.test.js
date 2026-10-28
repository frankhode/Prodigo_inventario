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
  } finally { await db.close(); }
});
