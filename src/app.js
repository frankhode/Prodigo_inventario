import { connect } from './data.js';
import { destinations, normalize, title, validate, csv, exportRecord, photoFiles } from './core.js';
import { compressPhoto, compressFrame } from './photos.js';
import { Camera, cameraError } from './camera.js';
import { createCropEditor, cropThumbnail, validCrop } from './photo-crop.js';
import { orderedBatchImages } from './batch.js';
import { Zip, ZipPassThrough, strToU8 } from 'fflate';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const state = {items:[],terms:[],destination:'',limit:24,current:null,draftId:null,step:0,photo:null,photoUrl:null,crop:null,gallery:[],dirty:false,busy:false,loading:false,user:null};
const stepTitles = ['Foto y objeto','Marca','Modelo','Fecha y numeración','Tipo','Destino y revisión'];
const config = globalThis.PRODIGO_CONFIG;
let db;
let batch = null;
let batchEditing = false;
let referenceUrl = null;
const inviteParams = new URLSearchParams(location.hash.slice(1));
const invitedUsername = inviteParams.get('alta');
const invitedCode = inviteParams.get('codigo');
let hasInvitation = ['aleProdigo','maxiProdigo'].includes(invitedUsername) && /^[a-f0-9]{32}$/.test(invitedCode || '');
function element(tag,className,text) {
  const node = document.createElement(tag); if (className) node.className = className;
  if (text !== undefined) node.textContent = text; return node;
}
function toast(message) {
  $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toast.timer);
  toast.timer = setTimeout(() => $('#toast').hidden = true,5000);
}
function errorText(error) {
  if (/user already registered/i.test(error.message)) return 'Ese correo ya tiene una cuenta. Ingresá con ella o usá otro correo para esta invitación.';
  if (/signups not allowed|signup.*disabled/i.test(error.message)) return 'El alta de cuentas todavía no está habilitada. Consultá a Pródigo.';
  if (/invalid login/i.test(error.message) || error.code === 'invalid_credentials') return 'Usuario, correo o contraseña incorrectos.';
  if (error.status === 401 || /JWT expired|refresh token/i.test(error.message)) return 'La sesión venció. Ingresá nuevamente en otra pestaña y reintentá; conservá esta ficha abierta.';
  if (/fetch|network|load failed/i.test(error.message)) return 'No se pudo conectar. Conservá esta ficha abierta y volvé a intentar.';
  return error.message || 'No se pudo completar la operación.';
}
function showAuth() { $('#loading').hidden = true; $('#app').hidden = true; $('#auth').hidden = false; }
function signupMode(enabled) {
  $('#login-form').hidden = enabled; $('#signup-form').hidden = !enabled;
  if (enabled && hasInvitation) {
    $('#signup-username').value = invitedUsername; $('#signup-username').disabled = true;
    $('#signup-code').value = invitedCode; $('#signup-code-label').hidden = true;
  } else if (enabled) {
    $('#signup-username').disabled = false; $('#signup-code-label').hidden = false;
  }
}
$('#open-signup').addEventListener('click',() => signupMode(true));
$('#back-to-login').addEventListener('click',() => signupMode(false));
$('#signup-form').addEventListener('submit',async event => {
  event.preventDefault(); const form = event.currentTarget;
  if ($('#signup-submit').disabled) return;
  $('#signup-error').textContent = '';
  if ($('#signup-password').value !== $('#signup-repeat').value) { $('#signup-error').textContent = 'Las contraseñas no coinciden.'; return; }
  $('#signup-submit').disabled = true; $('#back-to-login').disabled = true;
  try {
    const result = await db.register({username:$('#signup-username').value,email:$('#signup-email').value,
      password:$('#signup-password').value,invitationCode:$('#signup-code').value});
    if (!result.session) {
      $('#login-error').textContent = 'Cuenta creada. Revisá tu correo para confirmar el acceso y después ingresá.';
      signupMode(false);
    } else {
      signupMode(false);
      try { await enterApp(); toast('Tu cuenta está lista. Ya podés cargar objetos.'); }
      catch (error) { showAuth(); $('#login-error').textContent = 'La cuenta se creó. Volvé a ingresar para cargar el inventario. '+errorText(error); }
    }
    form.reset(); hasInvitation = false; history.replaceState(null,'',location.pathname+location.search);
  } catch (error) {
    $('#signup-error').textContent = /database error saving new user/i.test(error.message)
      ? 'No se pudo completar el alta. Comprobá que el enlace siga vigente y no se haya utilizado; si persiste, consultá a Pródigo.'
      : errorText(error);
  } finally { $('#signup-submit').disabled = false; $('#back-to-login').disabled = false; }
});
async function enterApp() {
  const snapshot = await db.load(); Object.assign(state,snapshot);
  $('#member-name').textContent = snapshot.member.display_name;
  $('#auth').hidden = true; $('#loading').hidden = true; $('#app').hidden = false;
  updateCategoryFilter(); render();
}
async function refresh(duringSave = false) {
  if (state.loading || (state.busy && duringSave !== true)) return;
  state.loading = true; $('#refresh').disabled = true;
  try {
    const snapshot = await db.load(); Object.assign(state,snapshot);
    $('#list-error').hidden = true; updateCategoryFilter(); render();
  } catch (error) { $('#list-error').textContent = errorText(error); $('#list-error').hidden = false; }
  finally { state.loading = false; $('#refresh').disabled = false; }
}
$('#login-form').addEventListener('submit',async event => {
  event.preventDefault(); const form = event.currentTarget; $('#login-submit').disabled = true; $('#login-error').textContent = '';
  try {
    await db.login(form.elements.identity.value.trim(),form.elements.password.value);
    await enterApp(); form.reset();
  } catch (error) { $('#login-error').textContent = errorText(error); }
  finally { $('#login-submit').disabled = false; }
});
$('#logout').addEventListener('click',async () => {
  try { await db.logout(); batch = null; renderBatchControls(); state.items = []; state.terms = []; state.user = null; $('#items').replaceChildren(); showAuth(); }
  catch (error) { toast(errorText(error)); }
});
$('#refresh').addEventListener('click',refresh);
function updateCategoryFilter() {
  const selected = $('#category-filter').value;
  const values = [...new Set(state.items.map(i => i.category))].sort((a,b) => a.localeCompare(b,'es'));
  $('#category-filter').replaceChildren(new Option('Todos los objetos',''),...values.map(v => new Option(v,v)));
  if (values.includes(selected)) $('#category-filter').value = selected;
}
function visibleItems() {
  const query = normalize($('#search').value.trim()), category = $('#category-filter').value;
  const visible = state.items.filter(i => (!state.destination || i.destination === state.destination) && (!category || i.category === category)
    && (!query || normalize([i.code,i.category,i.brand,i.model,i.manufacture_date,i.original_number,i.type,i.notes,destinations[i.destination]].join(' ')).includes(query)));
  if ($('#sort').value === 'brand') return visible.sort((a,b) => a.brand.localeCompare(b.brand,'es') || a.model.localeCompare(b.model,'es') || a.number-b.number);
  return visible.sort((a,b) => $('#sort').value === 'old' ? a.number-b.number : b.number-a.number);
}
function render() {
  $('#count-total').textContent = state.items.length;
  for (const key of Object.keys(destinations)) $(`#count-${key}`).textContent = state.items.filter(i => i.destination === key).length;
  const visible = visibleItems(); $('#result-count').textContent = visible.length;
  $('#items').replaceChildren(...visible.slice(0,state.limit).map(card));
  $('#empty').hidden = state.items.length > 0; $('#no-results').hidden = !state.items.length || visible.length > 0;
  $('#more-items').hidden = visible.length <= state.limit;
  $('#footer-count').textContent = `${state.items.length} objetos registrados`;
}
function card(item) {
  const button = element('button','card'); button.type = 'button';
  button.setAttribute('aria-label',`Editar ${item.code}, ${title(item)}`);
  const picture = element('div','card-image'), img = element('img');
  img.alt = title(item); img.loading = 'lazy'; picture.append(cropThumbnail(img,item.photo_crop));
  // Solo solicitar fotos de las tarjetas mostradas, nunca de las 5.000 fichas a la vez.
  db.photoUrl(item.photo_path).then(url => { if (button.isConnected) img.src = url; }).catch(() => { img.alt = 'Foto no disponible. Probá Actualizar.'; });
  const body = element('div','card-body');
  body.append(element('span','card-code',item.code),element('h3','',title(item)),element('p','card-meta',[item.category,item.manufacture_date,item.type,item.original_number && `N.º ${item.original_number}`].filter(Boolean).join(' · ')));
  const bottom = element('div','card-bottom'); bottom.append(element('span',`badge ${item.destination}`,destinations[item.destination]),element('span','card-edit','Editar ficha ↗'));
  body.append(bottom); button.append(picture,body); button.addEventListener('click',() => openEditor(item)); return button;
}
for (const id of ['search','sort','category-filter']) $(`#${id}`).addEventListener(id === 'search' ? 'input' : 'change',() => { state.limit = 24; render(); });
$$('.filter').forEach(button => button.addEventListener('click',() => {
  state.destination = button.dataset.destination; state.limit = 24;
  $$('.filter').forEach(b => { b.classList.toggle('active',b === button); b.setAttribute('aria-pressed',b === button); }); render();
}));
$('#reset-filters').addEventListener('click',() => { $('#search').value = ''; $('#category-filter').value = ''; $('.filter[data-destination=""]').click(); });
$('#more-items').addEventListener('click',() => { state.limit += 24; render(); });

const combos = ['category','brand','model','type'];
function comboValue(field) { const select = $(`#${field}-select`); return select.value === '__new__' ? $(`#${field}-new`).value.trim() : select.value; }
function optionsFor(field) {
  const category = comboValue('category'), brand = comboValue('brand');
  return state.terms.filter(t => t.kind === field && (field === 'category' || normalize(t.category) === normalize(category))
    && (field !== 'model' || normalize(t.parent_name) === normalize(brand))).map(t => t.name);
}
function fillCombo(field,value = '') {
  const values = [...new Set(optionsFor(field))].sort((a,b) => a.localeCompare(b,'es'));
  const select = $(`#${field}-select`), input = $(`#${field}-new`);
  select.replaceChildren(new Option(field === 'category' ? 'Elegí un objeto' : 'Sin consignar',''),...values.map(v => new Option(v,v)),new Option(`＋ Agregar ${field === 'category' ? 'objeto' : field === 'brand' ? 'marca' : field === 'model' ? 'modelo' : 'tipo'}…`,'__new__'));
  const known = values.find(v => normalize(v) === normalize(value));
  select.value = known || (value ? '__new__' : ''); input.value = known ? '' : value; input.hidden = select.value !== '__new__';
  if (field === 'model') {
    select.disabled = !comboValue('brand'); input.disabled = select.disabled;
    $('#model-help').textContent = select.disabled ? 'Si conocés el modelo, volvé al paso anterior y completá la marca.' : '';
  }
}
for (const field of combos) {
  $(`#${field}-select`).addEventListener('change',() => {
    const input = $(`#${field}-new`); input.hidden = $(`#${field}-select`).value !== '__new__';
    if (!input.hidden) input.focus();
    if (field === 'category') { fillCombo('brand'); fillCombo('model'); fillCombo('type'); }
    if (field === 'brand') fillCombo('model');
    state.dirty = true;
  });
  $(`#${field}-new`).addEventListener('input',() => {
    if (field === 'category') { fillCombo('brand'); fillCombo('model'); fillCombo('type'); }
    if (field === 'brand') fillCombo('model');
  });
}
function values() {
  return {category:comboValue('category'),brand:comboValue('brand'),model:comboValue('model'),type:comboValue('type'),
    manufacture_date:$('#manufacture-date').value.trim(),original_number:$('#original-number').value.trim(),destination:$('#item-form').elements.destination.value,notes:$('#notes').value.trim()};
}
function renderReview() {
  const v = values();
  const rows = [['Objeto',v.category],['Marca',v.brand],['Modelo',v.model],['Fecha',v.manufacture_date],['N.º de serie / numeración original',v.original_number],['Tipo',v.type]];
  $('#review').replaceChildren(...rows.flatMap(([label,value]) => [element('dt','',label),element('dd','',value || 'Sin consignar')]));
}
const maxExtraPhotos = 7;

function clearExtraPhotos() {
  for (const photo of state.gallery) if (photo.url) URL.revokeObjectURL(photo.url);
  state.gallery = [];
  $('#extra-photos-list').replaceChildren();
}
function updateExtraPhotoControls() {
  $('#add-extra-photos').disabled = state.busy || state.gallery.length >= maxExtraPhotos;
  $('#extra-photos-count').textContent = `${state.gallery.length} de ${maxExtraPhotos} adicionales`;
}
function renderExtraPhotos() {
  $('#extra-photos-list').replaceChildren(...state.gallery.map((photo,index) => {
    const card = element('div','extra-photo');
    const link = element('a');
    link.target = '_blank';
    link.rel = 'noopener';
    const image = element('img');
    image.alt = `Foto adicional ${index + 1}`;
    link.append(image);
    const show = url => { image.src = url; link.href = url; };
    if (photo.url) show(photo.url);
    else db.photoUrl(photo.path).then(url => { if (card.isConnected) show(url); })
      .catch(() => { image.alt = 'Foto no disponible'; });
    const remove = element('button','text-button','Quitar');
    remove.type = 'button';
    remove.disabled = state.busy;
    remove.setAttribute('aria-label',`Quitar foto adicional ${index + 1}`);
    remove.addEventListener('click',() => {
      if (state.busy) return;
      state.gallery.splice(index,1);
      if (photo.url) URL.revokeObjectURL(photo.url);
      state.dirty = true;
      renderExtraPhotos();
      $('#add-extra-photos').focus();
    });
    card.append(link,remove);
    return card;
  }));
  updateExtraPhotoControls();
}

$('#add-extra-photos').addEventListener('click',() => $('#extra-photos-input').click());
$('#extra-photos-input').addEventListener('change',async event => {
  const files = [...event.target.files];
  event.target.value = '';
  if (!files.length || state.busy) return;
  if (files.length > maxExtraPhotos - state.gallery.length) {
    $('#form-error').textContent = 'Elegí hasta siete fotos adicionales en total.';
    return;
  }
  busy(true);
  $('#form-error').textContent = '';
  try {
    for (const file of files) {
      const blob = await compressPhoto(file);
      state.gallery.push({blob,url:URL.createObjectURL(blob)});
      state.dirty = true;
    }
  } catch (error) { $('#form-error').textContent = errorText(error); }
  finally { busy(false); renderExtraPhotos(); }
});

function saveLabel() { return state.current ? 'Guardar cambios' : 'Guardar objeto'; }
function showStep(step) {
  state.step = step; $('#form-error').textContent = '';
  $$('.wizard-step').forEach((section,index) => section.hidden = index !== step);
  $('#step-caption').textContent = `${step+1} de 6 · ${stepTitles[step]}`; $('#step-progress').value = step+1;
  $('#previous-step').hidden = step === 0; $('#next-step').textContent = step === 5 ? saveLabel() : 'Siguiente →';
  if (step === 5) renderReview();
  const heading = $(`#step-title-${step}`); heading.tabIndex = -1; heading.focus({preventScroll:true}); $('#editor').scrollTop = 0;
}
async function openEditor(item = null) {
  state.current = item; state.draftId = item?.id || (batchEditing ? (batch.draftId ??= crypto.randomUUID()) : crypto.randomUUID()); state.photo = null;
  clearExtraPhotos();
  state.gallery = (item?.extra_photos ?? []).map(path => ({path}));
  state.crop = validCrop(item?.photo_crop) ? item.photo_crop : null;
  $('#crop-button').hidden = true;
  $('#delete-item').hidden = !item;
  if (state.photoUrl) URL.revokeObjectURL(state.photoUrl); state.photoUrl = null;
  state.dirty = false; $('#item-form').reset();
  for (const field of combos) fillCombo(field,item?.[field] || '');
  $('#manufacture-date').value = item?.manufacture_date || ''; $('#original-number').value = item?.original_number || ''; $('#notes').value = item?.notes || '';
  if (item) $('#item-form').elements.destination.value = item.destination;
  $('#editor-kicker').textContent = item?.code || 'NUEVO OBJETO'; $('#editor-title').textContent = item ? title(item) : 'Registrar un objeto';
  $('#item-dates').textContent = item ? `Alta: ${new Date(item.created_at).toLocaleDateString('es-AR')} · Revisión ${item.revision}` : '';
  $('#photo-stage').replaceChildren(element('span','',item ? 'Cargando foto…' : 'Una foto para reconocer el objeto.'));
  $('#photo-status').textContent = 'La portada se usa en la grilla.';
  renderExtraPhotos();
  renderBatchReference();
  $('#editor').showModal(); showStep(0);
  if (item) {
    try { const url = await db.photoUrl(item.photo_path); if ($('#editor').open && state.current?.id === item.id && !state.photo) showPhoto(url); }
    catch { $('#photo-status').textContent = 'No se pudo mostrar la foto. Podés conservarla o reemplazarla.'; }
  }
}
function updateCropButton() {
  $('#crop-button').textContent = state.crop ? 'Editar recorte de la grilla' : 'Recortar para la grilla';
}
function showPhoto(url) {
  const img = element('img');
  img.src = url;
  img.alt = 'Foto del objeto';
  $('#photo-stage').replaceChildren(img);
  updateCropButton();
  $('#crop-button').hidden = false;
}
const openCrop = createCropEditor($('#crop-dialog'), crop => {
  state.crop = crop;
  state.dirty = true;
  updateCropButton();
});
$('#crop-button').addEventListener('click',() => {
  const photo = $('#photo-stage img');
  if (!state.busy && photo) openCrop(photo.src,state.crop);
});
function busy(value) {
  state.busy = value;
  $$('#item-form button, #item-form input, #item-form select, #item-form textarea').forEach(control => control.disabled = value);
  updateExtraPhotoControls();
  if (!value) { $('#model-select').disabled = !comboValue('brand'); $('#model-new').disabled = !comboValue('brand'); }
}
$('#new-item').addEventListener('click',() => openEditor()); $('#empty-new').addEventListener('click',() => openEditor());
$('#item-form').addEventListener('input',event => {
  if (event.target !== $('#batch-is-object')) state.dirty = true;
});

function renderBatchControls() {
  $('#batch-start').hidden = Boolean(batch) || !('webkitdirectory' in $('#batch-folder'));
  $('#batch-files-button').hidden = Boolean(batch);
  $('#batch-resume').hidden = !batch;
  $('#batch-end').hidden = !batch;
  if (batch) $('#batch-resume').textContent = `Continuar lote · foto ${batch.index + 1} de ${batch.files.length}`;
}

function renderBatchReference() {
  if (referenceUrl) URL.revokeObjectURL(referenceUrl);
  referenceUrl = null;
  $('#batch-reference').hidden = !batchEditing;
  $('#editor').classList.toggle('has-batch',batchEditing);
  const preview = $('#batch-reference-image');
  const link = $('#batch-reference-open');
  preview.removeAttribute('src');
  link.removeAttribute('href');
  if (!batchEditing) return;
  const { files, index, nextIsObject } = batch;
  const candidate = files[index + 1];
  $('#batch-position').textContent = `Foto del objeto ${index + 1} de ${files.length} · ${files[index].name}`;
  $('#batch-is-object-label').hidden = !candidate;
  $('#batch-is-object').checked = nextIsObject;
  $('#batch-reference-name').textContent = candidate
    ? (nextIsObject ? `Siguiente objeto · ${candidate.name}` : candidate.name)
    : 'No queda una foto de ficha para este objeto.';
  const hasReference = Boolean(candidate && !nextIsObject);
  link.hidden = !hasReference;
  $('#batch-reference-error').hidden = true;
  if (hasReference) {
    referenceUrl = URL.createObjectURL(candidate);
    link.href = referenceUrl;
    preview.src = referenceUrl;
  }
}

async function openBatchItem() {
  if (!batch || state.busy || $('#editor').open) return;
  batchEditing = true;
  const file = batch.files[batch.index];
  const opening = openEditor();
  busy(true);
  try {
    await opening;
    setPhoto(await compressPhoto(file));
    state.dirty = false;
  } catch (error) {
    $('#form-error').textContent = `${file.name}: ${errorText(error)}`;
  } finally { busy(false); }
}

$('#batch-start').addEventListener('click',() => $('#batch-folder').click());
$('#batch-files-button').addEventListener('click',() => $('#batch-files').click());
for (const input of [$('#batch-folder'),$('#batch-files')]) input.addEventListener('change',() => {
  const files = orderedBatchImages(input.files);
  input.value = '';
  if (!files.length) { toast('No se encontraron imágenes en la selección.'); return; }
  if (batch || $('#editor').open) return;
  batch = { files, index:0, nextIsObject:false };
  renderBatchControls();
  openBatchItem();
});
$('#batch-resume').addEventListener('click',openBatchItem);
$('#batch-end').addEventListener('click',() => {
  if (!window.confirm('¿Cerrar el lote? Los objetos ya guardados quedan en el inventario.')) return;
  batch = null;
  renderBatchControls();
});
$('#batch-is-object').addEventListener('change',event => {
  batch.nextIsObject = event.currentTarget.checked;
  renderBatchReference();
});
$('#batch-reference-image').addEventListener('error',event => {
  if (event.currentTarget.getAttribute('src') === referenceUrl) $('#batch-reference-error').hidden = false;
});
renderBatchControls();

$('#previous-step').addEventListener('click',() => { if (!state.busy) showStep(Math.max(0,state.step-1)); });
async function closeEditor() {
  if (state.busy) return;
  if (state.dirty) {
    $('#confirm').returnValue = ''; $('#confirm').showModal();
    const discard = await new Promise(resolve => $('#confirm').addEventListener('close',() => resolve($('#confirm').returnValue === 'discard'),{once:true}));
    if (!discard) return;
  }
  $('#editor').close(); state.dirty = false;
  clearExtraPhotos();
  batchEditing = false; renderBatchReference();
  if (state.photoUrl) URL.revokeObjectURL(state.photoUrl); state.photoUrl = null;
}
$$('.close-editor').forEach(button => button.addEventListener('click',closeEditor));
$('#editor').addEventListener('cancel',event => { event.preventDefault(); closeEditor(); });
$('#delete-item').addEventListener('click',async () => {
  if (state.busy || !state.current) return;
  const item = state.current;
  $('#delete-description').textContent = `Se borrará ${item.code} · ${title(item)}, con sus datos y sus fotos. Esta acción no se puede deshacer. El identificador no se volverá a usar.`;
  $('#delete-confirm').returnValue = ''; $('#delete-confirm').showModal();
  const confirmed = await new Promise(resolve => $('#delete-confirm').addEventListener('close',() => resolve($('#delete-confirm').returnValue === 'delete'),{once:true}));
  if (!confirmed) return;
  busy(true); $('#form-error').textContent = '';
  try {
    const {photoCleanupFailed} = await db.remove({id:item.id,revision:item.revision,photoPath:item.photo_path,extraPhotos:item.extra_photos});
    state.items = state.items.filter(row => row.id !== item.id);
    state.dirty = false; state.photo = null; $('#editor').close();
    clearExtraPhotos();
    if (state.photoUrl) URL.revokeObjectURL(state.photoUrl); state.photoUrl = null;
    updateCategoryFilter(); render(); toast(`${item.code} borrado.`);
    if (photoCleanupFailed) {
      $('#list-error').textContent = 'El registro se borró, pero quedaron fotos pendientes de quitar del almacenamiento.'; $('#list-error').hidden = false;
    }
  } catch (error) { $('#form-error').textContent = errorText(error); }
  finally { busy(false); }
});
window.addEventListener('beforeunload',event => { if (batch || state.dirty || state.busy) { event.preventDefault(); event.returnValue = ''; } });
const camera = new Camera($('#camera-video'));
function closeCamera() { camera.stop(); if ($('#camera-dialog').open) $('#camera-dialog').close(); }
$('#camera-dialog').addEventListener('close',() => camera.stop());
$('#camera-dialog').addEventListener('cancel',event => { event.preventDefault(); if (!state.busy) closeCamera(); });
$('#cancel-camera').addEventListener('click',closeCamera);
$('#camera-button').addEventListener('click',async () => {
  if (state.busy || $('#camera-dialog').open) return;
  $('#camera-message').textContent = 'Activando cámara…'; $('#camera-message').className = 'hint';
  $('#take-photo').disabled = true; $('#camera-dialog').showModal();
  try {
    if (await camera.start()) {
      $('#camera-message').textContent = 'Encuadrá el objeto y tomá la foto.'; $('#take-photo').disabled = false;
    }
  } catch (error) { $('#camera-message').textContent = cameraError(error); $('#camera-message').className = 'error'; }
});
$('#camera-gallery').addEventListener('click',() => { closeCamera(); $('#gallery-input').click(); });
$('#native-camera').addEventListener('click',() => { closeCamera(); $('#camera-input').click(); });
$('#take-photo').addEventListener('click',async () => {
  if (state.busy) return;
  busy(true); $$('#camera-dialog button').forEach(button => button.disabled = true);
  $('#camera-message').textContent = 'Preparando foto…';
  try {
    const video = $('#camera-video');
    const photo = await compressFrame(video,video.videoWidth,video.videoHeight);
    if ($('#camera-dialog').open) { setPhoto(photo); closeCamera(); }
  } catch (error) { $('#camera-message').textContent = errorText(error); $('#camera-message').className = 'error'; }
  finally { busy(false); $$('#camera-dialog button').forEach(button => button.disabled = false); }
});
document.addEventListener('visibilitychange',() => { if (document.hidden) closeCamera(); });
window.addEventListener('pagehide',closeCamera);
$('#gallery-button').addEventListener('click',() => $('#gallery-input').click());
function setPhoto(photo) {
  if (state.photoUrl) URL.revokeObjectURL(state.photoUrl);
  state.crop = null;
  state.photo = photo; state.photoUrl = URL.createObjectURL(photo); showPhoto(state.photoUrl); state.dirty = true;
  $('#form-error').textContent = '';
  $('#photo-status').textContent = `Portada · ${Math.ceil(photo.size/1024)} KB. Podés reemplazarla antes de guardar.`;
}
for (const input of [$('#camera-input'),$('#gallery-input')]) input.addEventListener('change',async () => {
  const file = input.files[0]; input.value = ''; if (!file) return;
  busy(true); $('#form-error').textContent = '';
  try {
    setPhoto(await compressPhoto(file));
  } catch (error) { $('#form-error').textContent = errorText(error); }
  finally { busy(false); }
});
$('#item-form').addEventListener('submit',async event => {
  event.preventDefault(); if (state.busy) return;
  let continueBatch = false;
  try {
    for (const field of combos) {
      const step = {category:0,brand:1,model:2,type:4}[field];
      if (state.step === step && $(`#${field}-select`).value === '__new__' && !comboValue(field)) throw Error('Escribí el nombre de la nueva opción o elegí otra del listado.');
    }
    if (state.step === 0) {
      if (!state.photo && !state.current?.photo_path) throw Error('Tomá o elegí una foto.');
      if (!comboValue('category')) throw Error('Elegí el objeto.');
    }
    if (state.step < 5) { showStep(state.step+1); return; }
    const record = {...validate(values()),photo_crop:state.crop}; busy(true); $('#next-step').textContent = 'Guardando…';
    const saved = await db.save({id:state.draftId,revision:state.current?.revision || 0,values:record,photo:state.photo,photoPath:state.current?.photo_path,userId:state.user.id,
      gallery:state.gallery,previousExtraPhotos:state.current?.extra_photos});
    state.items = [...state.items.filter(i => i.id !== saved.id),saved];
    const savedFromBatch = batchEditing;
    if (savedFromBatch) {
      batch.index += batch.nextIsObject ? 1 : 2;
      batch.nextIsObject = false;
      batch.draftId = null;
      if (batch.index >= batch.files.length) batch = null;
      continueBatch = Boolean(batch);
      batchEditing = false; renderBatchReference(); renderBatchControls();
    }
    state.dirty = false;
    clearExtraPhotos();
    if (state.photoUrl) URL.revokeObjectURL(state.photoUrl); state.photoUrl = null;
    updateCategoryFilter(); render();
    toast(savedFromBatch && !continueBatch ? `${saved.code} guardado. Lote terminado.` : `${saved.code} guardado.`);
    // Recuperar los vocabularios antes de abrir la ficha siguiente.
    if (savedFromBatch) await refresh(true);
    $('#editor').close();
    if (!savedFromBatch) { busy(false); await refresh(); }
  } catch (error) { $('#form-error').textContent = errorText(error); }
  finally { busy(false); $('#next-step').textContent = state.step === 5 ? saveLabel() : 'Siguiente →'; }
  if (continueBatch) await openBatchItem();
});

function download(blob,name) {
  const url = URL.createObjectURL(blob), link = element('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url),30000);
}
const stamp = () => new Date().toISOString().slice(0,10);
$('#export-csv').addEventListener('click',() => download(new Blob([csv(state.items)],{type:'text/csv;charset=utf-8'}),`prodigo-${stamp()}.csv`));
$('#export-json').addEventListener('click',() => download(new Blob([JSON.stringify({format:'prodigo-inventario-v2',exported_at:new Date().toISOString(),items:state.items.map(exportRecord),terms:state.terms},null,2)],{type:'application/json'}),`prodigo-${stamp()}.json`));
$('#export-backup').addEventListener('click',async () => {
  if (state.busy) return;
  state.busy = true; const button = $('#export-backup'), status = $('#export-status'); button.disabled = true; status.hidden = false;
  const streaming = !!window.showSaveFilePicker;
  // En teléfonos, un ZIP de 5.000 fotos podría agotar la memoria. Descargar por partes.
  const snapshot = state.backup || {items:structuredClone(state.items),terms:structuredClone(state.terms),offset:0};
  const {items,terms} = snapshot;
  const photos = items.flatMap(photoFiles);
  const batch = streaming ? photos : photos.slice(snapshot.offset,snapshot.offset+200);
  const part = Math.floor(snapshot.offset/200)+1, parts = Math.max(1,Math.ceil(photos.length/200));
  let sink, chunks = [], zip, zipError;
  try {
    // En navegadores compatibles, escribir directamente en disco evita acumular el ZIP.
    if (streaming) {
      const handle = await window.showSaveFilePicker({suggestedName:`prodigo-${stamp()}.zip`,types:[{description:'Respaldo ZIP',accept:{'application/zip':['.zip']}}]});
      sink = await handle.createWritable();
    }
    let writing = Promise.resolve();
    zip = new Zip((error,data) => {
      if (error) { zipError = error; return; }
      if (sink) writing = writing.then(() => sink.write(data)); else chunks.push(data);
    });
    function add(name,data) { const entry = new ZipPassThrough(name); zip.add(entry); entry.push(data,true); }
    add('inventario.json',strToU8(JSON.stringify({format:'prodigo-inventario-v2',exported_at:new Date().toISOString(),items:items.map(exportRecord),terms},null,2)));
    add('inventario.csv',strToU8(csv(items)));
    const failures = [];
    for (let index = 0; index < batch.length; index++) {
      status.textContent = `Preparando respaldo: ${index+1} de ${batch.length} fotos${streaming ? '' : ` · parte ${part} de ${parts}`}… Mantené esta página abierta.`;
      try { const blob = await db.photoBlob(batch[index].path); add(batch[index].name,new Uint8Array(await blob.arrayBuffer())); }
      catch { failures.push(batch[index].name); }
      await writing; if (zipError) throw zipError;
    }
    if (failures.length) add('FOTOS_FALTANTES.txt',strToU8('Respaldo incompleto. No se pudieron descargar estas fotos:\n'+failures.join('\n')));
    zip.end(); await writing; if (zipError) throw zipError;
    if (sink) await sink.close(); else download(new Blob(chunks,{type:'application/zip'}),`prodigo-${stamp()}-parte-${String(part).padStart(3,'0')}-de-${parts}${failures.length ? '-incompleto' : ''}.zip`);
    if (!streaming && !failures.length && snapshot.offset+batch.length < photos.length) {
      state.backup = {...snapshot,offset:snapshot.offset+batch.length};
      button.textContent = `Descargar parte ${part+1} de ${parts}`;
      status.textContent = `Parte ${part} de ${parts} descargada. Continuá con la siguiente para completar el respaldo.`;
    } else if (failures.length) {
      state.backup = snapshot;
      status.textContent = `Respaldo incompleto: faltan ${failures.length} fotos. Revisá FOTOS_FALTANTES.txt y reintentá esta parte.`;
    } else {
      state.backup = null; button.textContent = 'Respaldo con fotos';
      status.textContent = `Respaldo completo: ${items.length} fichas y fotos${streaming ? '' : ` en ${parts} archivo(s)`}.`;
    }
  } catch (error) {
    zip?.terminate(); if (sink) await sink.abort().catch(() => {});
    status.textContent = error.name === 'AbortError' ? 'Respaldo cancelado.' : errorText(error);
  } finally { chunks = []; state.busy = false; button.disabled = false; }
});

document.addEventListener('visibilitychange',() => { if (!document.hidden && !$('#app').hidden && !$('#editor').open) refresh(); });
setInterval(() => { if (!document.hidden && !$('#app').hidden && !$('#editor').open) refresh(); },60000);
try {
  db = connect(config);
  if (!db) { $('#loading').hidden = true; $('#configuration').hidden = false; }
  else if (hasInvitation) { showAuth(); signupMode(true); }
  else if (await db.session()) {
    try { await enterApp(); } catch (error) { showAuth(); $('#login-error').textContent = errorText(error); }
  } else showAuth();
} catch (error) { $('#loading').textContent = errorText(error); }
