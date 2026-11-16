import test from 'node:test';
import assert from 'node:assert/strict';
import {parsePhysicalLabel} from '../src/bulk-workflow.js';
import {connect} from '../src/data.js';

const config={supabaseUrl:'https://fixture.example.test',publishableKey:'sb_publishable_fixture'};
const reply=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});

test('El número físico exige código válido sin renumeraciones implícitas',()=>{
  assert.equal(parsePhysicalLabel('P000401'),401);
  assert.equal(parsePhysicalLabel('401'),401);
  assert.equal(parsePhysicalLabel('000001'),1);
  for(const wrong of ['', 'P000000', '1000000', 'P123XYZ', '1-2', 'P-00001']) {
    assert.throws(()=>parsePhysicalLabel(wrong));
  }
});

test('El cliente envía un lote y asigna fotos sin depender del orden de archivo',async t=>{
  const calls=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    calls.push({url:String(url),body:JSON.parse(options.body)});
    return reply(String(url).includes('assign_inventory_bulk_image')
      ? {id:'img-2',code:'P000500',revision:1}
      : {id:'batch-1',start_number:500,end_number:501,total:2});
  });
  const db=connect(config);
  const images=[{id:'img-1',photo_path:'one.jpg',original_filename:'001.jpg'},
    {id:'img-2',photo_path:'two.jpg',original_filename:'002.jpg'}];
  await db.createBulkBatch({id:'batch-1',expectedStart:500,common:{category:'Fotografía',destination:'museo'},images});
  assert.deepEqual(calls[0].body,{p_id:'batch-1',p_expected_start:500,p_common:{category:'Fotografía',destination:'museo'},p_images:images});
  await db.assignBulkImage({batchId:'batch-1',imageId:'img-2',expectedNumber:500,details:{original_number:'000014'}});
  assert.ok(calls[1].url.endsWith('/rpc/assign_inventory_bulk_image'));
  assert.deepEqual(calls[1].body,{p_batch_id:'batch-1',p_image_id:'img-2',p_expected_number:500,p_details:{original_number:'000014'}});
});
