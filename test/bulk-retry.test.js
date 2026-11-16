import test from 'node:test';
import assert from 'node:assert/strict';
import {retryableTransferError,retryBulkTransfer} from '../src/bulk-retry.js';
import {connect} from '../src/data.js';

const config={supabaseUrl:'https://fixture.example.test',publishableKey:'sb_publishable_fixture'};
const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});

test('HTTP 520 de transferencia es reintentable; error de validación no',async()=>{
  const attempts=[];
  let count=0;
  const result=await retryBulkTransfer(async()=>{
    count++;
    if(count<3)throw Object.assign(Error('HTTP 520 error'),{status:520});
    return 'imagen-cargada';
  },{wait:async ms=>{attempts.push(ms);}});
  assert.equal(result,'imagen-cargada');
  assert.equal(count,3);
  assert.deepEqual(attempts,[650,1300]);
  assert.ok(retryableTransferError(Error('HTTP 520 error')));
  assert.ok(!retryableTransferError({status:409,message:'duplicate'}));
  let tries=0;
  await assert.rejects(retryBulkTransfer(async()=>{
    tries++;throw Object.assign(Error('Invalid number'),{status:400});
  },{wait:async()=>{}}),/Invalid number/);
  assert.equal(tries,1);
});

test('Si Supabase responde 520 después de confirmar, recupera la reserva por UUID',async t=>{
  const calls=[];
  const id='22222222-2222-4222-8222-222222222222';
  t.mock.method(globalThis,'fetch',async (url,options)=>{
    calls.push({url:String(url),method:options.method});
    if(String(url).includes('/rpc/create_inventory_bulk_batch'))
      return response({message:'HTTP 520 error'},520);
    if(String(url).includes('/inventory_bulk_batches'))
      return response({id,total:2,start_number:500,end_number:501});
    throw Error('Unexpected request');
  });
  const db=connect(config);
  const batch=await db.createBulkBatch({id,expectedStart:500,common:{category:'Fotografía',destination:'museo'},images:[{},{}]});
  assert.equal(batch.id,id);
  assert.equal(batch.start_number,500);
  assert.equal(calls.filter(x=>x.url.includes('create_inventory_bulk_batch')).length,1);
  assert.equal(calls.filter(x=>x.url.includes('/inventory_bulk_batches')).length,1);
});

test('Si no puede verificar una reserva tras 520, no genera un segundo rango',async t=>{
  const calls=[];
  const id='33333333-3333-4333-8333-333333333333';
  t.mock.method(globalThis,'fetch',async (url,options)=>{
    calls.push(String(url));
    if(String(url).includes('/rpc/create_inventory_bulk_batch'))
      return response({message:'HTTP 520 error'},520);
    if(String(url).includes('/inventory_bulk_batches'))
      return response([]);
    throw Error('Unexpected request');
  });
  const db=connect(config);
  await assert.rejects(
    db.createBulkBatch({id,expectedStart:500,common:{category:'Fotografía',destination:'museo'},images:[{},{}]}),
    e=>e.code==='BULK_RESERVATION_UNCERTAIN'
  );
  assert.equal(calls.filter(x=>x.includes('/rpc/create_inventory_bulk_batch')).length,1);
});
