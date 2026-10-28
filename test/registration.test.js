import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

test('Alta propia: solo dos invitaciones, atómicas y de un solo uso',async t => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create schema storage;
      create table auth.users(id uuid primary key,email text unique,raw_user_meta_data jsonb default '{}'::jsonb);
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid; $$;
      create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      create table storage.objects(bucket_id text,name text);
      alter table storage.objects enable row level security;
      create function storage.foldername(text) returns text[] language sql immutable as $$ select string_to_array($1,'/'); $$;
      grant usage on schema public,auth,storage to anon,authenticated,service_role;
      alter default privileges in schema public grant all on tables to anon,authenticated;
    `);
    for (const name of ['202610280001_inventory.sql','202610280002_usernames.sql']) {
      await db.exec(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
    }
    const fran = randomUUID();
    await db.query("insert into auth.users(id,email) values ($1,'fran@example.test')",[fran]);
    await db.query("insert into public.inventory_members(user_id,display_name,username) values ($1,'Fran','franProdigo')",[fran]);
    const results = await db.exec(await readFile(new URL('../supabase/migrations/202610280003_self_registration.sql',import.meta.url),'utf8'));
    const links = results.at(-1).rows;
    const codes = Object.fromEntries(links.map(row => [row.username,new URLSearchParams(new URL(row.enlace_de_alta).hash.slice(1)).get('codigo')]));
    const enroll = (username,code,email,id = randomUUID()) => db.query('insert into auth.users(id,email,raw_user_meta_data) values ($1,$2,$3::jsonb) returning *',[id,email,JSON.stringify({username,inventory_invite:code})]);

    await t.test('Genera dos enlaces y guarda solo hashes, con vencimiento',async () => {
      assert.deepEqual(Object.keys(codes),['aleProdigo','maxiProdigo']);
      assert.match(codes.aleProdigo,/^[a-f0-9]{32}$/);
      const rows = (await db.query('select * from public.inventory_invites')).rows;
      for (const row of rows) { assert.notEqual(row.token_hash,codes[row.username]); assert.equal(row.used_at,null); assert.ok(new Date(row.expires_at)>new Date()); }
    });
    await t.test('Bloquea altas sin código, código incorrecto o código de otra persona',async () => {
      await assert.rejects(db.query("insert into auth.users(id,email) values ($1,'intruso@example.test')",[randomUUID()]),/invitación válida/);
      await assert.rejects(enroll('aleProdigo','a'.repeat(32),'ale@example.test'),/invitación no está disponible/);
      await assert.rejects(enroll('maxiProdigo',codes.aleProdigo,'maxi@example.test'),/invitación no está disponible/);
      assert.equal((await db.query('select * from auth.users')).rows.length,1);
    });
    await t.test('Rechaza enlaces vencidos y regenerar uno pendiente invalida el anterior',async () => {
      await db.query("update public.inventory_invites set expires_at=now()-interval '1 day' where username='aleProdigo'");
      await assert.rejects(enroll('aleProdigo',codes.aleProdigo,'ale@example.test'),/invitación no está disponible/);
      const oldCode = codes.aleProdigo;
      codes.aleProdigo = (await db.query("select * from public.create_inventory_invite('aleProdigo')")).rows[0].invitation_code;
      assert.notEqual(codes.aleProdigo,oldCode);
      await assert.rejects(enroll('aleProdigo',oldCode,'ale@example.test'),/invitación no está disponible/);
    });
    await t.test('Ale se registra, obtiene membresía y el código desaparece del perfil',async () => {
      const user = (await enroll('ALEPRODIGO',codes.aleProdigo,'ale@example.test')).rows[0];
      assert.deepEqual(user.raw_user_meta_data,{username:'aleProdigo'});
      const member = (await db.query('select * from public.inventory_members where user_id=$1',[user.id])).rows[0];
      assert.equal(member.username,'aleProdigo'); assert.equal(member.display_name,'Ale');
      const invite = (await db.query("select * from public.inventory_invites where username='aleProdigo'")).rows[0];
      assert.equal(invite.used_by,user.id); assert.ok(invite.used_at);
      await assert.rejects(enroll('aleProdigo',codes.aleProdigo,'otro@example.test'),/invitación no está disponible/);
      await assert.rejects(db.query("select * from public.create_inventory_invite('aleProdigo')"),/ya tiene una cuenta/);
    });
    await t.test('Un error de alta no consume la invitación de Maxi',async () => {
      await assert.rejects(enroll('maxiProdigo',codes.maxiProdigo,'fran@example.test'),/duplicate key/);
      const invite = (await db.query("select * from public.inventory_invites where username='maxiProdigo'")).rows[0];
      assert.equal(invite.used_at,null); assert.equal(invite.used_by,null);
      const user = (await enroll('maxiProdigo',codes.maxiProdigo,'maxi@example.test')).rows[0];
      assert.equal((await db.query('select username from public.inventory_members where user_id=$1',[user.id])).rows[0].username,'maxiProdigo');
      assert.equal((await db.query('select * from public.inventory_members')).rows.length,3);
    });
    await t.test('Las invitaciones no pueden leerse ni generarse desde el navegador',async () => {
      for (const role of ['anon','authenticated','service_role']) {
        await db.exec(`set role ${role}`);
        await assert.rejects(db.query('select * from public.inventory_invites'),/permission denied/);
        await assert.rejects(db.query("select * from public.create_inventory_invite('maxiProdigo')"),/permission denied/);
        await db.exec('reset role');
      }
      await assert.rejects(db.query("select * from public.create_inventory_invite('franProdigo')"),/Nombre no disponible/);
    });
  } finally { await db.close(); }
});
