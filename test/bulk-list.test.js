import test from 'node:test';
import assert from 'node:assert/strict';
import {unlinkedBulkEntries} from '../src/bulk-list.js';

const source={
  system:'prodigo-catalogador',collection_name:'F. Bixio y Cia.',
  record:{signature:'BIX-01',people:['Niñas'],color:'byn'},
  parts:[{record:{side:'Reverso',notes:'Dedicatoria'}}]
};
const batch={id:'lote-bixio',common_values:{category:'Fotografía',destination:'museo'},
  created_at:'2026-11-16T15:00:00Z',start_number:400,end_number:402};
const photos=[
  {id:'frente-a',photo_path:'a.jpg',original_filename:'img024.tif',
    image_values:{brand:'Florencio Bixio',original_number:'000127',manufacture_date:'ca. 1900'},
    extra_photos:['reverso.jpg'],source_data:source},
  {id:'frente-b',photo_path:'b.jpg',original_filename:'img025.tif',
    image_values:{brand:'F. Bixio y Cía.'},extra_photos:[],source_data:source},
  {id:'frente-c',photo_path:'c.jpg',original_filename:'img026.tif',
    image_values:{},extra_photos:[],source_data:source}
];

test('Muestra todos los frentes sin asociar dentro del mismo catálogo visual',()=>{
  const result=unlinkedBulkEntries([{batch,details:{
    images:photos,slots:[{number:400,image_id:null},{number:401,image_id:null},{number:402,image_id:null}]
  }}]);
  assert.equal(result.length,3);
  assert.ok(result.every(x=>x.isBulkUnlinked&&x.code===null&&x.number===null));
  assert.ok(result.every(x=>x.bulkBatchId==='lote-bixio'));
  assert.deepEqual(result[0].bulkRange,{start:400,end:402});
  assert.equal(result[0].category,'Fotografía');
  assert.equal(result[0].destination,'museo');
  assert.equal(result[0].original_number,'000127');
  assert.deepEqual(result[0].extra_photos,['reverso.jpg']);
  assert.equal(result[0].catalog_source.record.signature,'BIX-01');
});

test('Cuando se vincula una imagen con la etiqueta, sale de los pendientes',()=>{
  const result=unlinkedBulkEntries([{batch,details:{
    images:photos,slots:[{number:400,image_id:'frente-b'},{number:401,image_id:null},{number:402,image_id:null}]
  }}]);
  assert.deepEqual(result.map(x=>x.id),['frente-a','frente-c']);
  assert.ok(result.every(x=>!x.code&&!x.number));
});

test('Los rangos de lotes diferentes no se atribuyen arbitrariamente a las fotos',()=>{
  const b2={id:'lote-2',common_values:{category:'Máquina de escribir',destination:'tienda'},
    start_number:403,end_number:403,created_at:'2026-11-17T09:00:00Z'};
  const rows=unlinkedBulkEntries([
    {batch,details:{images:[photos[0]],slots:[{number:400,image_id:null}]}},
    {batch:b2,details:{images:[{id:'objeto',photo_path:'m.jpg',original_filename:'m.jpg'}],
      slots:[{number:403,image_id:null}]}}
  ]);
  assert.equal(rows.length,2);
  assert.equal(rows[1].category,'Máquina de escribir');
  assert.equal(rows[1].destination,'tienda');
  assert.equal(rows[1].code,null);
  assert.equal(rows[1].bulkRange.start,403);
});

test('No duplica imágenes ya numeradas y tolera lotes vacíos',()=>{
  assert.deepEqual(unlinkedBulkEntries([]),[]);
  assert.deepEqual(unlinkedBulkEntries([{batch,details:{images:[],slots:[]}}]),[]);
  assert.deepEqual(unlinkedBulkEntries([{batch,details:{images:photos.slice(0,1),slots:[{image_id:'frente-a'}]}}]),[]);
});
