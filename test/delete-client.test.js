import test from 'node:test';
import assert from 'node:assert/strict';
import { connect } from '../src/data.js';

const config = {supabaseUrl:'https://fixture.example.test',publishableKey:'sb_publishable_fixture'};
const item = {id:'22222222-2222-4222-8222-222222222222',revision:3,photoPath:'user/item/photo.jpg'};
const json = (body,status=200) => new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});

test('el cliente borra por revisión antes de limpiar la foto y permite reintentos',async t => {
  const calls = []; let alreadyDeleted = false;
  t.mock.method(globalThis,'fetch',async (url,options) => {
    calls.push({url:String(url),body:JSON.parse(options.body)});
    if (String(url).includes('/rpc/')) return json(alreadyDeleted ? null : item.photoPath);
    return json([]);
  });
  const db = connect(config);
  assert.deepEqual(await db.remove(item),{photoCleanupFailed:false});
  assert.ok(calls[0].url.endsWith('/rpc/delete_inventory_item'));
  assert.deepEqual(calls[0].body,{p_id:item.id,p_revision:3});
  assert.deepEqual(calls[1].body,{prefixes:[item.photoPath]});
  alreadyDeleted = true;
  assert.deepEqual(await db.remove(item),{photoCleanupFailed:false});
  assert.deepEqual(calls[3].body,{prefixes:[item.photoPath]});
});
test('un conflicto no quita la foto; una instalación pendiente muestra un error claro',async t => {
  let calls = 0, missing = false;
  t.mock.method(globalThis,'fetch',async () => {
    calls++;
    return json(missing ? {code:'PGRST202',message:'Function missing'} : {code:'40001',message:'Otra persona modificó esta ficha.'},missing ? 404 : 409);
  });
  const db = connect(config);
  await assert.rejects(db.remove(item),error => error.code === '40001' && /Otra persona modificó/.test(error.message)); assert.equal(calls,1);
  missing = true;
  await assert.rejects(db.remove(item),/todavía no está habilitada/); assert.equal(calls,2);
});
test('si falla limpiar Storage, el registro sigue confirmado como borrado',async t => {
  t.mock.method(globalThis,'fetch',async url => String(url).includes('/rpc/')
    ? json(item.photoPath) : json({message:'Storage unavailable',statusCode:500},500));
  assert.deepEqual(await connect(config).remove(item),{photoCleanupFailed:true});
});
