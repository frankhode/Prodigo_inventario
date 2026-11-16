import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CATALOG_BASE,safeCatalogMedia,extractPublishedCatalog,
  getPublishedCollections,readPublishedCatalog,downloadCatalogImage
} from '../src/catalog-import.js';

const id1='a'.repeat(64),id2='b'.repeat(64),id3='c'.repeat(64),id4='d'.repeat(64),id5='e'.repeat(64),id6='f'.repeat(64);
const media=id=>({
  src:`media/bixio/${id}-0123456789abcdef.webp`,
  thumb:`media/bixio/${id}-0123456789abcdef-thumb.webp`
});
const record=(side,parent='',extra={})=>({side,parent,...extra});
const fixture={
  format:'prodigo-online',id:'bixio',name:'F. Bixio y Cia.',version:'test',updated:'2026-10-26T20:00:00Z',
  signatures:{'BIX-01':'F. Bixio & Cía. — relieve tipográfico'},
  images:{
    [id1]:{status:'done',relative:'img024.tif',record:record('Frente','',{
      number:'000127',author:'Florencio Bixio',date:'ca. 1900',kind:'Retrato',
      people:['Niñas'],highlights:['Vestimenta'],signature:'BIX-01',color:'byn'
    }),media:media(id1)},
    [id2]:{status:'done',relative:'img024b.tif',record:record('Reverso',id1,{
      notes:'Dedicado a su familia',displayOrder:1
    }),media:media(id2)},
    [id3]:{status:'done',relative:'img024c.tif',record:record('Otros',id2,{
      notes:'Detalle de la firma',displayOrder:2
    }),media:media(id3)},
    [id4]:{status:'done',relative:'img025.tif',record:record('Frente','',{
      number:'72540',author:'',kind:'Retrato'
    }),media:media(id4)},
    [id5]:{status:'done',relative:'img000.tif',record:record('Reverso',''),media:media(id5)},
    [id6]:{status:'pending',excluded:true,relative:'img999.tif',record:{},media:media(id6)}
  }
};

test('El catalogador importa un solo objeto por frente y conserva vínculos en cadena',()=>{
  const result=extractPublishedCatalog(fixture);
  assert.equal(result.records.length,2);
  assert.equal(result.partCount,2);
  assert.equal(result.unlinkedParts.length,1);
  assert.equal(result.excludedCount,1);
  const first=result.records[0];
  assert.equal(first.sourceKey,`prodigo-catalogador:bixio:${id1}`);
  assert.deepEqual(first.files.map(part=>part.side),['Frente','Reverso','Otros']);
  assert.deepEqual(first.sourceData.parts.map(part=>part.original_filename),['img024b.tif','img024c.tif']);
  assert.equal(first.sourceData.record.signature,'BIX-01');
  assert.equal(first.sourceData.signature_label,'F. Bixio & Cía. — relieve tipográfico');
  assert.deepEqual(first.sourceData.record.highlights,['Vestimenta']);
  assert.equal(first.imageValues.original_number,'000127');
  assert.equal(first.imageValues.manufacture_date,'ca. 1900');
  assert.equal(first.imageValues.brand,'Florencio Bixio');
  assert.equal(first.filename,'img024.tif');
  assert.equal(result.records[1].files.length,1);
  assert.equal(result.records[1].imageValues.brand,'');
});
test('No acepta datos de catalogador de origen desconocido',()=>{
  assert.throws(()=>extractPublishedCatalog({format:'bad',id:'bixio',images:{}}),/Formato/);
  assert.throws(()=>safeCatalogMedia('https://otro-sitio.test/foto.webp'),/ruta/);
  assert.throws(()=>safeCatalogMedia('../privado'),/ruta/);
  assert.ok(safeCatalogMedia(media(id1).src).startsWith(CATALOG_BASE));
});
test('Consulta índice y colección publicados sin modificar datos',async()=>{
  const calls=[];
  const fake=async url=>{
    calls.push(url);
    return {ok:true,json:async()=>url.endsWith('index.json')
      ? {format:'prodigo-collections',collections:[{
        id:'bixio',name:'F. Bixio y Cia.',path:'data/collections/bixio.json',done:197,total:197
      }]}
      : fixture};
  };
  const collections=await getPublishedCollections(fake);
  const read=await readPublishedCatalog(collections[0],fake);
  assert.equal(read.records.length,2);
  assert.deepEqual(calls.map(x=>x.slice(CATALOG_BASE.length)),
    ['data/index.json','data/collections/bixio.json']);
});
test('Se restringe la descarga de imágenes al catálogo público',async()=>{
  const url=safeCatalogMedia(media(id2).src);
  await assert.rejects(downloadCatalogImage('https://otro-sitio.test/imagen.webp'),/no pertenece/);
  const returned=await downloadCatalogImage(url,async request=>({
    ok:true,headers:new Headers({'content-length':'4'}),blob:async()=>new Blob(['foto'])
  }));
  assert.equal(returned.size,4);
});
