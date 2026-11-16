// Lectura de las colecciones fotográficas publicadas de Pródigo.
// Los TIF originales permanecen intactos en su origen; se copian vistas WEBP.
export const CATALOG_BASE = 'https://raw.githubusercontent.com/frankhode/prodigo-catalogador/main/';
const HEX64 = /^[a-f0-9]{64}$/;
const RELATIVE_MEDIA = /^media\/[a-z0-9-]+\/[a-f0-9]{64}-[a-f0-9]+(?:-thumb)?\.webp$/;
const COLL = new Intl.Collator('es',{numeric:true,sensitivity:'base'});
const PART_RANK = {Reverso:1,Tapa:2,Interior:3,Otros:4,'Escaneo HD':5};

export function safeCatalogMedia(path) {
  if(typeof path!=='string'||!RELATIVE_MEDIA.test(path))throw Error('El catalogador contiene una ruta de imagen inválida.');
  return CATALOG_BASE+path;
}
async function getJSON(path,fetcher) {
  if(!/^data\/(?:index\.json|collections\/[a-z0-9-]+\.json)$/.test(path))throw Error('Ruta de colección inválida.');
  const result=await fetcher(CATALOG_BASE+path,{cache:'no-store',credentials:'omit'});
  if(!result.ok)throw Error(`No se pudo leer el catalogador (HTTP ${result.status}).`);
  return result.json();
}
export async function getPublishedCollections(fetcher=fetch) {
  const data=await getJSON('data/index.json',fetcher);
  if(data?.format!=='prodigo-collections'||!Array.isArray(data.collections))
    throw Error('El índice del catalogador no tiene el formato esperado.');
  return data.collections.filter(c=>/^[a-z0-9-]+$/.test(c.id)&&c.path===`data/collections/${c.id}.json`)
    .map(c=>({id:c.id,name:c.name,path:c.path,done:c.done,total:c.total}));
}
const fileName = item => item.relative||item.file||'Imagen sin nombre';
const photoParts = (images,frontId,frontIds) => {
  const pairs=[];
  for(const [id,item] of images) {
    if(id===frontId||item?.status!=='done'||item?.excluded||item?.record?.side==='Frente'||!item?.media?.src)continue;
    let parent=item.record?.parent,seen=new Set([id]),root=null;
    while(parent&&!seen.has(parent)) {
      seen.add(parent);
      if(frontIds.has(parent)) {root=parent;break;}
      const ancestor=images.get(parent);
      if(!ancestor||ancestor.status!=='done'||ancestor.excluded||!ancestor.media?.src)break;
      parent=ancestor.record?.parent;
    }
    if(root===frontId)pairs.push({id,item});
  }
  pairs.sort((a,b)=>{
    const aa=a.item.record?.displayOrder,bb=b.item.record?.displayOrder;
    if(Number.isFinite(aa)&&Number.isFinite(bb)&&aa!==bb)return aa-bb;
    if(Number.isFinite(aa))return -1;
    if(Number.isFinite(bb))return 1;
    return (PART_RANK[a.item.record?.side]||10)-(PART_RANK[b.item.record?.side]||10)
      ||COLL.compare(fileName(a.item),fileName(b.item));
  });
  return pairs;
};
export function extractPublishedCatalog(data) {
  if(data?.format!=='prodigo-online'||!data.id||!data.images||typeof data.images!=='object')
    throw Error('Formato de colección fotográfica incompatible.');
  const images=new Map(Object.entries(data.images));
  const fronts=[...images].filter(([id,item])=>
    HEX64.test(id)&&item?.status==='done'&&!item?.excluded&&item.record?.side==='Frente'&&item.media?.src
  );
  const frontIds=new Set(fronts.map(([id])=>id));
  const linkedIds=new Set();
  const records=fronts.map(([id,item])=>{
    const parts=photoParts(images,id,frontIds);
    parts.forEach(p=>linkedIds.add(p.id));
    if(parts.length>7)throw Error(`La fotografía ${fileName(item)} tiene más de 7 imágenes complementarias.`);
    const original=item.record||{};
    const files=[{id,side:'Frente',filename:fileName(item),src:safeCatalogMedia(item.media.src),
      thumb:safeCatalogMedia(item.media.thumb||item.media.src)},...parts.map(({id, item:p})=>({
      id,side:p.record.side,filename:fileName(p),src:safeCatalogMedia(p.media.src),
      thumb:safeCatalogMedia(p.media.thumb||p.media.src)
    }))];
    const sourceKey=`prodigo-catalogador:${data.id}:${id}`;
    const sourceData={
      system:'prodigo-catalogador',collection_id:data.id,collection_name:data.name,
      collection_version:data.version,source_id:id,original_filename:fileName(item),
      original_updated:item.updated||null,record:structuredClone(original),
      signature_label:data.signatures?.[original.signature]||null,
      parts:parts.map(({id,item:p})=>({
        id,original_filename:fileName(p),record:structuredClone(p.record),
        signature_label:data.signatures?.[p.record?.signature]||null,
        updated:p.updated||null
      }))
    };
    const imageValues={
      brand:String(original.author||'').trim().slice(0,120),
      manufacture_date:String(original.date||'').trim().slice(0,80),
      original_number:String(original.number||'').trim().slice(0,120),
      type:String(original.kind||'').trim().slice(0,120),
      notes:String(original.notes||'').trim().slice(0,4000)
    };
    return {sourceKey,sourceData,imageValues,filename:fileName(item),files};
  });
  records.sort((a,b)=>COLL.compare(a.filename,b.filename));
  const usableParts=[...images].filter(([id,item])=>
    item?.status==='done'&&!item?.excluded&&item.record?.side!=='Frente'&&item.media?.src);
  return {
    collection:data.name,collectionId:data.id,updated:data.updated||null,
    records,partCount:linkedIds.size,
    unlinkedParts:usableParts.filter(([id])=>!linkedIds.has(id)).map(([id,item])=>({
      id,side:item.record?.side||'Sin tipo',filename:fileName(item)
    })),
    excludedCount:[...images.values()].filter(item=>item.excluded||item.status!=='done').length
  };
}
export async function readPublishedCatalog(collection,fetcher=fetch) {
  if(!collection||!collection.path)throw Error('Elegí una colección.');
  return extractPublishedCatalog(await getJSON(collection.path,fetcher));
}
export async function downloadCatalogImage(url,fetcher=fetch) {
  if(typeof url!=='string'||!url.startsWith(CATALOG_BASE)||!RELATIVE_MEDIA.test(url.slice(CATALOG_BASE.length)))
    throw Error('La ruta de la imagen no pertenece al catalogador.');
  const response=await fetcher(url,{credentials:'omit'});
  if(!response.ok)throw Error(`No se pudo descargar una fotografía del catalogador (HTTP ${response.status}).`);
  const length=Number(response.headers.get('content-length')||0);
  if(length>40*1024*1024)throw Error('Una imagen excede el límite de 40 MB.');
  const blob=await response.blob();
  if(blob.size>40*1024*1024)throw Error('Una imagen excede el límite de 40 MB.');
  return blob;
}
