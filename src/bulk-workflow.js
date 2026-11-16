// Carga masiva con correspondencia física manual (sin inferir el orden de la caja).
import { compressPhoto } from './photos.js';
import { orderedBulkFolderImages } from './batch.js';
import { getPublishedCollections, readPublishedCatalog, downloadCatalogImage } from './catalog-import.js';

const $ = selector => document.querySelector(selector);
const fmt = number => 'P'+String(number).padStart(6,'0');
const safeText = (value,max=120) => String(value ?? '').trim().slice(0,max);
const accepted = /\.(?:jpe?g|png|webp)$/i;
export function parsePhysicalLabel(input) {
  const text = String(input || '').trim().toUpperCase();
  if (!/^(?:P)?[0-9]{1,6}$/.test(text)) throw Error('Ingresá el número de la próxima etiqueta, por ejemplo P000401.');
  const number = Number(text.replace(/^P/,''));
  if (!Number.isSafeInteger(number) || number < 1 || number > 999999) throw Error('Número de etiqueta fuera de rango.');
  return number;
}
export function mountBulkWorkflow({getDb,getUser,getTerms,onInventoryChanged,notify}) {
  const dialog = $('#bulk-dialog');
  let stage = [];
  let uploads = new Map();
  let extraUploads = new Map();
  let catalogSummary = null;
  let catalogCollections = [];
  let currentBatchId = null;
  let batch = null;
  let images = [];
  let slots = [];
  let linkedItems = new Map();
  let focused = null;
  let busy = false;
  let folderLabel = '';
  let stagingId = crypto.randomUUID();
  let search = '';
  let filter = 'pending';
  const thumbnailObserver = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver(entries=>{
      for(const entry of entries) {
        if(!entry.isIntersecting)continue;
        const image=entry.target;
        thumbnailObserver.unobserve(image);
        const path=image.dataset.bulkPhotoPath;
        if(path) getDb().photoUrl(path).then(url=>{
          if(image.isConnected&&image.dataset.bulkPhotoPath===path)image.src=url;
        }).catch(()=>{if(image.isConnected)image.alt='Imagen no disponible';});
      }
    },{root:dialog.querySelector('[data-bulk-view="work"]'),rootMargin:'200px'})
    : null;
  const view = name => {
    for (const element of dialog.querySelectorAll('[data-bulk-view]')) element.hidden = element.dataset.bulkView !== name;
    $('#bulk-error').textContent = '';
  };
  const setBusy = value => {
    busy = value;
    for (const control of dialog.querySelectorAll('button,input,select,textarea')) {
      if (control.id !== 'bulk-close') control.disabled = value;
    }
    $('#bulk-close').disabled = value;
  };
  const message = error => { $('#bulk-error').textContent = String(error?.message || error); };
  const releaseStage = () => {
    for (const item of stage) if (item.localUrl) URL.revokeObjectURL(item.localUrl);
    stage = []; uploads = new Map(); extraUploads = new Map(); catalogSummary = null;
    stagingId = crypto.randomUUID();
  };
  async function open() {
    if (!getDb()) return;
    dialog.showModal();
    view('home');
    await listBatches();
  }
  async function listBatches() {
    $('#bulk-batches').replaceChildren();
    try {
      const list = await getDb().listBulkBatches();
      if (!list.length) $('#bulk-batches').append(Object.assign(document.createElement('p'),{textContent:'Todavía no hay lotes numerados.'}));
      for (const entry of list) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'bulk-batch-row';
        const name = entry.common_values?.category || 'Objetos';
        button.textContent = `${name} · ${fmt(entry.start_number)}–${fmt(entry.end_number)} · ${entry.total} piezas · ${new Date(entry.created_at).toLocaleDateString('es-AR')}`;
        button.onclick = () => loadBatch(entry);
        $('#bulk-batches').append(button);
      }
    } catch (error) { message(error); }
  }
  async function showCatalogCollections() {
    if (busy) return;
    setBusy(true);
    try {
      catalogCollections = await getPublishedCollections();
      const selector=$('#bulk-catalog-select');
      selector.replaceChildren();
      for(const collection of catalogCollections) {
        const option=document.createElement('option');
        option.value=collection.id;
        option.textContent=`${collection.name} · ${collection.done} imágenes catalogadas`;
        selector.append(option);
      }
      if(!catalogCollections.length)throw Error('No se encontraron colecciones publicadas.');
      $('#bulk-catalog-picker').hidden=false;
    } catch(error) {message(error);}
    finally{setBusy(false);}
  }
  async function loadCatalogCollection() {
    if (busy) return;
    const selected=catalogCollections.find(c=>c.id===$('#bulk-catalog-select').value);
    if(!selected){message('Elegí una colección.');return;}
    setBusy(true);
    try {
      const [parsed,already]=await Promise.all([
        readPublishedCatalog(selected),
        getDb().importedCatalogKeys(selected.id)
      ]);
      const available=parsed.records.filter(item=>!already.has(item.sourceKey));
      if(!available.length)throw Error('Todos los frentes de esta colección ya están en lotes del inventario.');
      releaseStage();
      catalogSummary={
        collection:parsed.collection,unlinked:parsed.unlinkedParts,
        skipped:parsed.records.length-available.length,linked:available.reduce((n,item)=>n+item.files.length-1,0),
        total:parsed.records.length
      };
      folderLabel=parsed.collection;
      stage=available.map(item=>({
        id:crypto.randomUUID(),filename:item.filename,sourceKey:item.sourceKey,
        sourceData:item.sourceData,imageValues:item.imageValues,
        files:item.files,url:item.files[0].thumb,
        supported:true,included:true
      }));
      search='';$('#bulk-validation-search').value='';
      renderValidation();view('validation');
    }catch(error){message(error);}
    finally{setBusy(false);}
  }
  function addFiles(files, title) {
    const ordered = orderedBulkFolderImages(files);
    if (!ordered.length) { message('No se encontraron imágenes en la carpeta.'); return; }
    releaseStage();
    folderLabel = title || 'Carpeta seleccionada';
    stage = ordered.map(file => {
      const url=URL.createObjectURL(file);
      return {id:crypto.randomUUID(),file,filename:file.webkitRelativePath || file.name,
        included:accepted.test(file.name),supported:accepted.test(file.name),url,localUrl:url};
    });
    search = '';
    $('#bulk-validation-search').value = '';
    renderValidation();
    view('validation');
  }
  function chosen() { return stage.filter(item=>item.included); }
  function renderValidation() {
    const kept = chosen().length;
    $('#bulk-validation-count').textContent = `${kept} seleccionadas de ${stage.length} · ${folderLabel}`;
    const unsupported = stage.filter(item=>!item.supported).length;
    $('#bulk-validation-warning').textContent = catalogSummary
      ? `${chosen().reduce((n,item)=>n+(item.files.length-1),0)} imágenes complementarias de los frentes seleccionados. ${catalogSummary.unlinked.length} partes sin frente verificable quedan fuera de la importación. ${catalogSummary.skipped} frentes ya ingresados se omitieron. Los originales no se modifican.`
      : unsupported
        ? `${unsupported} archivos TIFF, HEIC u otros formatos no compatibles se excluyeron automáticamente. Para esta versión usá JPG, PNG o WebP derivados de los originales.`
        : 'Tocá una miniatura para excluirla o incorporarla nuevamente; los originales no se borran.';
    const grid = $('#bulk-validation-grid');
    grid.replaceChildren();
    const query = search.trim().toLowerCase();
    for (const item of stage.filter(item=>item.filename.toLowerCase().includes(query))) {
      const button = document.createElement('button'); button.type='button'; button.className='bulk-tile';
      button.classList.toggle('excluded',!item.included);
      button.disabled = !item.supported;
      const image = document.createElement('img'); image.loading='lazy'; image.alt=''; image.src=item.url;
      const label = document.createElement('span'); label.textContent=item.filename;
      const status = document.createElement('small');
      status.textContent=!item.supported?'Formato pendiente'
        :item.sourceKey?`${item.included?'Incluida':'Excluida'} · Frente + ${item.files.length-1} partes · ${item.imageValues.manufacture_date||'s/f'}`
        :item.included?'Incluida':'Excluida';
      button.append(image,label,status);
      button.onclick=()=>{item.included=!item.included;renderValidation();};
      grid.append(button);
    }
    $('#bulk-validation-next').disabled = !kept;
  }
  function fillCategorySuggestions() {
    const list = $('#bulk-category-options'); list.replaceChildren();
    const names = new Set(['Fotografía',...getTerms().filter(row=>row.kind==='category').map(row=>row.name)]);
    for (const name of names) {
      const option = document.createElement('option'); option.value=name; list.append(option);
    }
  }
  function openMetadata() {
    if (!chosen().length) { message('Elegí al menos una imagen.'); return; }
    fillCategorySuggestions();
    $('#bulk-category').value='Fotografía';
    $('#bulk-destination').value='';
    for (const id of ['brand','model','date','original-number','type','notes']) $('#bulk-'+id).value='';
    $('#bulk-start-number').value='';
    $('#bulk-meta-count').textContent=`${chosen().length} fotografías elegidas${catalogSummary ? ` · ${chosen().reduce((n,item)=>n+(item.files.length-1),0)} imágenes vinculadas · metadatos conservados` : ''}`;
    view('metadata');
  }
  function commonValues() {
    const values = {
      category:safeText($('#bulk-category').value),
      destination:$('#bulk-destination').value,
      brand:safeText($('#bulk-brand').value),
      model:safeText($('#bulk-model').value),
      manufacture_date:safeText($('#bulk-date').value,80),
      original_number:safeText($('#bulk-original-number').value),
      type:safeText($('#bulk-type').value),
      notes:safeText($('#bulk-notes').value,4000)
    };
    if (!values.category) throw Error('Elegí el tipo de objeto.');
    if (!['museo','tienda','otros'].includes(values.destination)) throw Error('Elegí el destino del material.');
    if (values.model && !values.brand) throw Error('El modelo requiere una marca o autor.');
    return values;
  }
  async function commit() {
    if (busy) return;
    let number,common;
    try { number=parsePhysicalLabel($('#bulk-start-number').value); common=commonValues(); }
    catch(error){message(error);return;}
    if (!window.confirm(`Vas a reservar ${chosen().length} números a partir de ${fmt(number)}. Se conservarán definitivamente, aunque no termines de etiquetar todas las fotos. ¿Continuar?`)) return;
    setBusy(true); view('uploading');
    const selected = chosen();
    const paths = [...uploads.values(),...Array.from(extraUploads.values()).flat()];
    try {
      for (let index=0;index<selected.length;index++) {
        const item = selected[index];
        $('#bulk-upload-progress').textContent=`Preparando y subiendo fotografía ${index+1} de ${selected.length}: ${item.filename}`;
        if (!uploads.has(item.id)) {
          const file=item.sourceKey ? await downloadCatalogImage(item.files[0].src) : item.file;
          const blob=await compressPhoto(file);
          const path=await getDb().stageBulkPhoto(item.id,getUser().id,blob);
          uploads.set(item.id,path);
        }
        if(item.sourceKey) {
          const savedExtras=extraUploads.get(item.id)||[];
          for(let partIndex=1;partIndex<item.files.length;partIndex++) {
            if(savedExtras[partIndex-1])continue;
            const part=item.files[partIndex];
            $('#bulk-upload-progress').textContent=`Fotografía ${index+1}/${selected.length} · ${part.side}: ${part.filename}`;
            const original=await downloadCatalogImage(part.src);
            const blob=await compressPhoto(original);
            savedExtras[partIndex-1]=await getDb().stageBulkPhoto(item.id,getUser().id,blob);
            extraUploads.set(item.id,savedExtras);
          }
        }
      }
      $('#bulk-upload-progress').textContent='Verificando numeración y creando el lote…';
      const result=await getDb().createBulkBatch({
        id:stagingId,expectedStart:number,common,
        images:selected.map(item=>({
          id:item.id,original_filename:item.filename.slice(0,250),photo_path:uploads.get(item.id),
          ...(item.sourceKey?{
            extra_photos:extraUploads.get(item.id)||[],
            source_key:item.sourceKey,source_data:item.sourceData,image_values:item.imageValues
          }:{})
        }))
      });
      releaseStage();
      await loadBatch(result);
      notify(`Lote creado: ${fmt(result.start_number)}–${fmt(result.end_number)}.`);
    } catch (error) {
      // Errores antes de confirmación SQL no crean fichas; las imágenes quedan
      // disponibles para reintentar sin subirlas dos veces.
      message(error);
      const notice=document.createElement('p'); notice.textContent='Los archivos ya subidos se conservarán para reintentar sin repetir la transferencia. Si el correlativo no coincide, corregí la primera etiqueta física.';
      $('#bulk-upload-progress').replaceChildren(notice);
      view('metadata');
      $('#bulk-error').textContent=error?.message || 'No se pudo crear el lote.';
    } finally { setBusy(false); }
  }
  async function loadBatch(record) {
    setBusy(true);
    try {
      const details=await getDb().bulkDetails(record.id);
      batch=record; currentBatchId=record.id;
      images=details.images; slots=details.slots;
      linkedItems=new Map(details.items.map(item=>[item.id,item]));
      focused=null; filter='pending'; $('#bulk-work-filter').value='pending';
      $('#bulk-work-search').value=''; renderWork();
      view('work');
    } catch(error){message(error);}
    finally{setBusy(false);}
  }
  function pendingSlot() { return slots.find(slot=>!slot.image_id) || null; }
  function assignedNumber(imageId) { return slots.find(slot=>slot.image_id===imageId)?.number ?? null; }
  function isLabeled(imageId) { return Boolean(linkedItems.get(imageId)?.label_confirmed_at); }
  function renderWork() {
    const linked=slots.filter(slot=>Boolean(slot.image_id)).length;
    const labeled=slots.filter(slot=>slot.image_id&&isLabeled(slot.image_id)).length;
    const next=pendingSlot();
    $('#bulk-work-title').textContent=`${batch.common_values.category} · ${fmt(batch.start_number)}–${fmt(batch.end_number)}`;
    $('#bulk-work-progress').textContent=`${labeled} etiquetadas · ${linked-labeled} vinculadas sin etiqueta · ${batch.total-linked} sin vincular`;
    $('#bulk-next-number').textContent=next?fmt(next.number):'Sin más números';
    $('#bulk-work-complete').hidden=labeled!==batch.total;
    const grid=$('#bulk-work-grid');
    thumbnailObserver?.disconnect();grid.replaceChildren();
    const query=$('#bulk-work-search').value.trim().toLowerCase();
    for(const item of images.filter(item=>(filter==='all'||!isLabeled(item.id))&&item.original_filename.toLowerCase().includes(query))) {
      const number=assignedNumber(item.id),labeled=isLabeled(item.id);
      const button=document.createElement('button');button.type='button';button.className='bulk-tile';
      if(labeled)button.classList.add('done');
      else if(number)button.classList.add('claimed');
      const image=document.createElement('img');image.loading='lazy';image.alt='';
      image.dataset.bulkPhotoPath=item.photo_path;
      if(thumbnailObserver)thumbnailObserver.observe(image);
      else getDb().photoUrl(item.photo_path).then(url=>{
        if(button.isConnected)image.src=url;
      }).catch(()=>{image.alt='Imagen no disponible';});
      const text=document.createElement('span');text.textContent=item.original_filename;
      const badge=document.createElement('small');
      badge.textContent=labeled?`${fmt(number)} · Etiquetada`:number?`${fmt(number)} · Falta pegar etiqueta`:'Sin vincular';
      button.append(image,text,badge);
      button.onclick=()=>openImage(item);
      grid.append(button);
    }
    if (!grid.childElementCount) {
      const note=document.createElement('p');note.textContent=labeled===batch.total
        ? 'Todas las imágenes del lote están etiquetadas.'
        : 'No hay fotografías que coincidan con los filtros.';
      grid.append(note);
    }
  }
  function openImage(item) {
    focused=item;
    const number=assignedNumber(item.id),labeled=isLabeled(item.id),next=pendingSlot();
    $('#bulk-detail-filename').textContent=item.original_filename;
    $('#bulk-detail-number').textContent=number?fmt(number):next?fmt(next.number):'Sin números disponibles';
    $('#bulk-detail-message').textContent=labeled
      ? 'La etiqueta física ya fue confirmada. Podés corregir los metadatos desde la ficha del inventario.'
      : number
        ? 'El número quedó vinculado a esta imagen. Ahora pegá esta etiqueta en el sobre físico y confirmá su colocación.'
        : 'Verificá la imagen e ingresá los datos individuales que quieras. Primero vinculá el número; NO pegues la etiqueta hasta que se confirme la asociación.';
    const action=$('#bulk-detail-save');
    action.hidden=labeled||(!number&&!next);
    action.textContent=number?`Ya pegué ${fmt(number)} · Confirmar etiqueta`
      :`Vincular fotografía con ${fmt(next?.number)}`;
    for(const [id,key] of [['brand','brand'],['date','manufacture_date'],['original-number','original_number'],['type','type'],['notes','notes']]) {
      $('#bulk-detail-'+id).value=item.image_values?.[key] || '';
      $('#bulk-detail-'+id).disabled=Boolean(number);
    }
    const preview=$('#bulk-detail-image');preview.removeAttribute('src');
    getDb().photoUrl(item.photo_path).then(url=>{if(focused?.id===item.id)preview.src=url;}).catch(error=>message(error));
    view('detail');
  }
  async function confirmPhysicalLabel() {
    if(busy||!focused)return;
    const item=focused,existingNumber=assignedNumber(item.id);
    setBusy(true);
    try {
      if(existingNumber) {
        const linked=linkedItems.get(item.id);
        if(!linked) throw Error('La ficha vinculada no está disponible. Actualizá el lote.');
        const saved=await getDb().setLabel({
          id:item.id,revision:linked.revision,labeled:true
        });
        await onInventoryChanged(saved);
        await loadBatch(batch);
        notify(`${saved.code}: etiqueta física confirmada.`);
      } else {
        const next=pendingSlot();
        if(!next) throw Error('Este lote ya no tiene números disponibles.');
        const details={
          brand:safeText($('#bulk-detail-brand').value),
          manufacture_date:safeText($('#bulk-detail-date').value,80),
          original_number:safeText($('#bulk-detail-original-number').value),
          type:safeText($('#bulk-detail-type').value),
          notes:safeText($('#bulk-detail-notes').value,4000)
        };
        // Los campos sin completar heredan los valores comunes.
        for(const [key,value] of Object.entries(details))if(!value)delete details[key];
        const saved=await getDb().assignBulkImage({
          batchId:batch.id,imageId:item.id,expectedNumber:next.number,details
        });
        await onInventoryChanged(saved);
        await loadBatch(batch);
        const updated=images.find(image=>image.id===item.id);
        if(updated)openImage(updated);
        notify(`${saved.code} vinculado a la fotografía. Ahora colocá la etiqueta.`);
      }
    } catch(error){message(error);}
    finally{setBusy(false);}
  }
  async function close() {
    if(busy)return;
    if(stage.length) {
      const warning=uploads.size||extraUploads.size
        ? 'Todavía no reservaste números. Si cerrás, perderás esta selección y habrá que volver a subir los archivos. ¿Descartar la preparación?'
        : 'Esta selección no se ha incorporado al inventario. ¿Descartarla?';
      if(!window.confirm(warning))return;
      if(uploads.size||extraUploads.size) {
        setBusy(true);
        try { await getDb().discardUnreservedBulkFiles([
          ...uploads.values(),...Array.from(extraUploads.values()).flat()
        ]); }
        catch(error){notify('No se pudieron limpiar algunos archivos temporales.');}
        finally{setBusy(false);}
      }
      releaseStage();
    }
    dialog.close();
  }
  $('#bulk-open').addEventListener('click',open);
  $('#bulk-close').addEventListener('click',close);
  dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
  $('#bulk-catalog-open').addEventListener('click',showCatalogCollections);
  $('#bulk-catalog-load').addEventListener('click',loadCatalogCollection);
  $('#bulk-folder-button').addEventListener('click',()=>$('#bulk-folder-input').click());
  $('#bulk-files-button').addEventListener('click',()=>$('#bulk-files-input').click());
  for(const id of ['folder','files']) {
    $('#bulk-'+id+'-input').addEventListener('change',event=>{
      const files=[...event.target.files]; event.target.value='';
      addFiles(files,id==='folder'&&files.length?files[0].webkitRelativePath.split('/')[0]:'Archivos seleccionados');
    });
  }
  $('#bulk-validation-search').addEventListener('input',event=>{search=event.target.value;renderValidation();});
  $('#bulk-validation-all').addEventListener('click',()=>{stage.forEach(i=>i.included=i.supported);renderValidation();});
  $('#bulk-validation-none').addEventListener('click',()=>{stage.forEach(i=>i.included=false);renderValidation();});
  $('#bulk-validation-next').addEventListener('click',openMetadata);
  $('#bulk-validation-back').addEventListener('click',()=>view('home'));
  $('#bulk-meta-back').addEventListener('click',()=>view('validation'));
  $('#bulk-create').addEventListener('click',commit);
  $('#bulk-work-search').addEventListener('input',renderWork);
  $('#bulk-work-filter').addEventListener('change',event=>{filter=event.target.value;renderWork();});
  $('#bulk-work-refresh').addEventListener('click',()=>loadBatch(batch));
  $('#bulk-work-back').addEventListener('click',async()=>{view('home');await listBatches();});
  $('#bulk-detail-back').addEventListener('click',()=>{focused=null;renderWork();view('work');});
  $('#bulk-detail-save').addEventListener('click',confirmPhysicalLabel);
}
