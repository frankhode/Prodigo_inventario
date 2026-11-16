import test from 'node:test';
import assert from 'node:assert/strict';
import { connect } from '../src/data.js';

const config = {supabaseUrl:'https://fixture.example.test',publishableKey:'sb_publishable_fixture'};
const response = (body,status=200) => new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
const example = {id:'22222222-2222-4222-8222-222222222222',code:'P000042',revision:4,label_confirmed_at:'2026-11-16T12:00:00Z'};

test('confirma la etiqueta por RPC con id, revisión y estado exactos',async t => {
  const calls = [];
  t.mock.method(globalThis,'fetch',async (url,options) => {
    calls.push({url:String(url),body:JSON.parse(options.body)});
    return response(example);
  });
  const saved = await connect(config).setLabel({id:example.id,revision:3,labeled:true});
  assert.deepEqual(saved,example);
  assert.ok(calls[0].url.endsWith('/rpc/set_inventory_label'));
  assert.deepEqual(calls[0].body,{p_id:example.id,p_revision:3,p_labeled:true});
});
test('rechaza el estado no disponible o una ficha vencida',async t => {
  let missing = true;
  t.mock.method(globalThis,'fetch',async () => missing
    ? response({code:'PGRST202',message:'Function missing'},404)
    : response({code:'40001',message:'Otra persona modificó esta ficha.'},409));
  const db = connect(config);
  await assert.rejects(db.setLabel({id:example.id,revision:3,labeled:true}),/migración de etiquetado/);
  missing = false;
  await assert.rejects(db.setLabel({id:example.id,revision:3,labeled:false}),/Otra persona modificó/);
});
