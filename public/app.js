const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const state = { items: [], destination: '', current: null, photos: [], selected: 0, dirty: false, busy: false, setup: false };
const labels = { museo: 'Museo', tienda: 'Tienda', otros: 'Otros' };
const normalize = value => value.toLocaleLowerCase('es').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const dateFormat = value => new Date(value).toLocaleDateString('es-AR', { day: 'numeric', month: 'short', year: 'numeric' });
function el(tag, className, content) {
  const node = document.createElement(tag); if (className) node.className = className;
  if (content !== undefined) node.textContent = content; return node;
}
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS(svg.namespaceURI, 'use'); use.setAttribute('href', `#i-${name}`); svg.append(use); svg.setAttribute('aria-hidden', 'true'); return svg;
}
async function api(url, options = {}) {
  let response;
  try { response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'prodigo', ...options.headers } }); }
  catch { throw new Error('No hay conexión con el servidor. Conservá esta ficha abierta y volvé a intentar.'); }
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && url !== '/api/login') toast('La sesión venció. Volvé a ingresar para continuar.');
    throw new Error(data.error || 'No se pudo completar la operación.');
  }
  return data;
}
let toastTimer;
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').hidden = true, 4200); }
function showAuth(setup) {
  state.setup = setup; $('#loading').hidden = true; $('#app').hidden = true; $('#auth').hidden = false;
  $('#setup-label').hidden = !setup; $('#setup-help').hidden = !setup;
  $('#auth-title').textContent = setup ? 'Abramos el inventario.' : 'Bienvenido de nuevo.';
  $('#auth-description').textContent = setup ? 'Creá una contraseña para proteger los datos y las fotografías.' : 'Ingresá para consultar y cargar el inventario.';
  const password = $('#login-form').elements.password;
  password.autocomplete = setup ? 'new-password' : 'current-password'; password.minLength = setup ? 10 : 1;
  $('#login-form').elements.token.required = setup;
  $('#login-submit').textContent = setup ? 'Crear inventario →' : 'Ingresar →';
}
async function enterApp() {
  $('#auth').hidden = true; $('#loading').hidden = true; $('#app').hidden = false;
  await loadItems();
}
async function loadItems() {
  $('#list-error').hidden = true;
  try { state.items = (await api('/api/items')).items; render(); }
  catch (error) { $('#list-error').textContent = error.message + ' Recargá la página para reintentar.'; $('#list-error').hidden = false; }
}
$('#login-form').addEventListener('submit', async event => {
  event.preventDefault(); $('#login-error').textContent = ''; $('#login-submit').disabled = true;
  try {
    const form = event.currentTarget;
    await api(state.setup ? '/api/setup' : '/api/login', { method: 'POST', body: JSON.stringify({ token: form.elements.token.value.trim(), password: form.elements.password.value }) });
    form.reset(); await enterApp();
  } catch (error) { $('#login-error').textContent = error.message; }
  finally { $('#login-submit').disabled = false; }
});
$('#logout').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST', body: '{}' }); state.items = []; $('#items').replaceChildren(); showAuth(false); }
  catch (error) { toast(error.message); }
});
function render() {
  $('#count-total').textContent = state.items.length;
  for (const destination of Object.keys(labels)) $(`#count-${destination}`).textContent = state.items.filter(item => item.destination === destination).length;
  const query = normalize($('#search').value.trim());
  const visible = state.items.filter(item => (!state.destination || item.destination === state.destination) && (!query || normalize([item.code,item.brand,item.model,item.date,item.type,item.notes,labels[item.destination]].join(' ')).includes(query)));
  if ($('#sort').value === 'old') visible.sort((a,b) => a.id - b.id);
  if ($('#sort').value === 'brand') visible.sort((a,b) => a.brand.localeCompare(b.brand, 'es') || a.model.localeCompare(b.model, 'es'));
  $('#result-count').textContent = visible.length; $('#footer-count').textContent = `${state.items.length} ${state.items.length === 1 ? 'objeto registrado' : 'objetos registrados'}`;
  $('#empty').hidden = state.items.length > 0; $('#no-results').hidden = state.items.length === 0 || visible.length > 0;
  $('#items').replaceChildren(...visible.map(card));
  $('#brands').replaceChildren(...[...new Set(state.items.map(i => i.brand))].sort((a,b) => a.localeCompare(b,'es')).map(brand => { const option = el('option'); option.value = brand; return option; }));
  const types = new Set(['Mecánica portátil','Mecánica de escritorio','Eléctrica','Electrónica',...state.items.map(i => i.type).filter(Boolean)]);
  $('#types').replaceChildren(...[...types].map(type => { const option = el('option'); option.value = type; return option; }));
}
function card(item) {
  const button = el('button', 'card'); button.type = 'button'; button.setAttribute('aria-label', `Abrir ${item.code}, ${item.brand} ${item.model}`);
  const picture = el('div','card-image');
  if (item.photos.length) { const img = el('img'); img.src = item.photos[0].url; img.alt = `${item.brand} ${item.model}`; img.loading = 'lazy'; picture.append(img); }
  else picture.append(icon('typewriter'));
  if (item.photos.length > 1) { const count = el('span', 'photo-badge'); count.append(icon('image'), document.createTextNode(item.photos.length)); picture.append(count); }
  const body = el('div','card-body'); const title = el('h3', '', item.brand); if (item.model) title.append(document.createTextNode(' '), el('small','',item.model));
  body.append(el('span','card-code',item.code),title,el('p','card-meta',[item.date,item.type].filter(Boolean).join(' · ') || 'Sin fecha ni tipo consignados'));
  const bottom = el('div','card-bottom'); const badge = el('span',`badge ${item.destination}`); badge.append(el('i',`dot ${{museo:'museum',tienda:'shop',otros:'other'}[item.destination]}`),document.createTextNode(labels[item.destination])); bottom.append(badge,el('span','card-arrow','↗')); body.append(bottom); button.append(picture,body);
  button.addEventListener('click', () => openEditor(item)); return button;
}
$('#search').addEventListener('input',render); $('#sort').addEventListener('change',render);
$$('.filter').forEach(button => button.addEventListener('click', () => {
  state.destination = button.dataset.destination;
  $$('.filter').forEach(filter => { const active = filter === button; filter.classList.toggle('active',active); filter.setAttribute('aria-pressed',active); }); render();
}));
$('#reset-filters').addEventListener('click', () => { $('#search').value = ''; $('.filter[data-destination=""]').click(); });
function openEditor(item = null) {
  state.current = item; state.photos = item ? item.photos.map(photo => ({...photo})) : []; state.selected = 0; state.dirty = false; state.busy = false;
  const form = $('#item-form'); form.reset(); $('#form-error').textContent = '';
  $('#editor-title').textContent = item ? `${item.brand}${item.model ? ` ${item.model}` : ''}` : 'Nuevo ítem';
  $('#editor-kicker').textContent = item ? item.code : 'AMPLIAR EL ARCHIVO'; $('#delete-item').hidden = !item;
  $('#item-dates').textContent = item ? `Alta: ${dateFormat(item.created_at)} · Última edición: ${dateFormat(item.updated_at)}` : '';
  if (item) for (const name of ['brand','model','date','type','destination','notes']) form.elements[name].value = item[name];
  renderPhotos(); $('#editor').showModal();
  if (!item && matchMedia('(min-width: 601px)').matches) $('#brand').focus();
}
$('#new-item').addEventListener('click', () => openEditor()); $('#empty-new').addEventListener('click', () => openEditor());
$('#item-form').addEventListener('input', () => state.dirty = true);
async function ask(title, copy, action = 'Eliminar') {
  $('#confirm-title').textContent = title; $('#confirm-copy').textContent = copy; $('#confirm button[value="delete"]').textContent = action;
  $('#confirm').returnValue = ''; $('#confirm').showModal();
  return new Promise(resolve => $('#confirm').addEventListener('close', () => resolve($('#confirm').returnValue === 'delete'), { once: true }));
}
async function closeEditor() {
  if (state.busy) return;
  if (state.dirty && !await ask('¿Cerrar sin guardar?', 'Los cambios de esta ficha todavía no se guardaron.', 'Descartar cambios')) return;
  $('#editor').close(); state.dirty = false;
}
$$('.close-editor').forEach(button => button.addEventListener('click', closeEditor));
$('#editor').addEventListener('cancel', event => { event.preventDefault(); closeEditor(); });
window.addEventListener('beforeunload', event => { if ($('#editor').open && state.dirty) { event.preventDefault(); event.returnValue = ''; } });
function renderPhotos() {
  const stage = $('#photo-stage'); stage.replaceChildren();
  if (state.photos.length) { const img = el('img'); img.src = state.photos[state.selected]?.data || state.photos[state.selected]?.url; img.alt = `Foto ${state.selected + 1} del ítem`; stage.append(img); }
  else stage.append(icon('camera'),el('span','','Mostrá lo que lo hace único.'),el('small','','Podés agregar hasta 5 fotos.'));
  $('#photo-count').textContent = `${state.photos.length} / 5`;
  $('#photo-thumbs').replaceChildren(...state.photos.map((photo,index) => {
    const thumb = el('div', `thumb${index === state.selected ? ' selected' : ''}`); const view = el('button'); view.type = 'button'; view.setAttribute('aria-label',`Ver foto ${index+1}${index === 0 ? ', portada' : ''}`);
    const img = el('img'); img.src = photo.data || photo.url; img.alt = ''; view.append(img); view.addEventListener('click', () => { state.selected = index; renderPhotos(); });
    const remove = el('button','remove'); remove.type = 'button'; remove.setAttribute('aria-label',`Quitar foto ${index+1}`); remove.append(icon('close')); remove.addEventListener('click', () => { state.photos.splice(index,1); state.selected = Math.min(state.selected, Math.max(0,state.photos.length-1)); state.dirty = true; renderPhotos(); });
    thumb.append(view,remove); return thumb;
  }));
  $('#camera-button').disabled = state.photos.length >= 5 || state.busy; $('#gallery-button').disabled = state.photos.length >= 5 || state.busy;
}
$('#camera-button').addEventListener('click', () => $('#camera-input').click()); $('#gallery-button').addEventListener('click', () => $('#gallery-input').click());
async function compress(file) {
  if (!file.type.startsWith('image/') && !/\.(jpe?g|png|webp|heic|heif)$/i.test(file.name)) throw new Error('Elegí un archivo de imagen.');
  if (file.size > 40 * 1024 * 1024) throw new Error('La foto original supera los 40 MB. Elegí una más pequeña.');
  const url = URL.createObjectURL(file);
  try {
    const img = new Image(); img.src = url;
    try { await img.decode(); } catch { throw new Error('El navegador no puede abrir esta foto. Probá con JPEG, PNG o WebP.'); }
    const scale = Math.min(1,1600 / Math.max(img.naturalWidth,img.naturalHeight));
    const canvas = document.createElement('canvas'); canvas.width = Math.max(1,Math.round(img.naturalWidth*scale)); canvas.height = Math.max(1,Math.round(img.naturalHeight*scale));
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0,0,canvas.width,canvas.height); ctx.drawImage(img,0,0,canvas.width,canvas.height);
    return canvas.toDataURL('image/jpeg',.84);
  } finally { URL.revokeObjectURL(url); }
}
for (const input of [$('#camera-input'),$('#gallery-input')]) input.addEventListener('change', async () => {
  const files = [...input.files]; input.value = ''; if (!files.length) return;
  $('#form-error').textContent = ''; state.busy = true; $('#save-item').disabled = true; renderPhotos();
  try {
    if (files.length + state.photos.length > 5) throw new Error('Podés agregar hasta 5 fotos. Seleccioná menos archivos.');
    for (const file of files) { state.photos.push({ data: await compress(file) }); state.dirty = true; state.selected = state.photos.length - 1; renderPhotos(); }
  } catch (error) { $('#form-error').textContent = error.message; }
  finally { state.busy = false; $('#save-item').disabled = false; renderPhotos(); }
});
$('#item-form').addEventListener('submit', async event => {
  event.preventDefault(); if (state.busy) return;
  state.busy = true; $('#save-item').disabled = true; $('#form-error').textContent = ''; $('#save-item').textContent = 'Guardando…';
  const form = event.currentTarget; const body = Object.fromEntries(new FormData(form));
  body.photos = state.photos.map(photo => photo.id ? { id:photo.id } : { data:photo.data }); if (state.current) body.version = state.current.version;
  try {
    const saved = await api(state.current ? `/api/items/${state.current.id}` : '/api/items', { method: state.current ? 'PUT' : 'POST', body:JSON.stringify(body) });
    state.items = [saved, ...state.items.filter(item => item.id !== saved.id)].sort((a,b) => b.id-a.id); state.dirty = false; $('#editor').close(); render(); toast(`${saved.code} guardado.`);
  } catch (error) { $('#form-error').textContent = error.message; }
  finally { state.busy = false; $('#save-item').disabled = false; $('#save-item').replaceChildren(icon('check'),document.createTextNode('Guardar ítem')); }
});
$('#delete-item').addEventListener('click', async () => {
  if (state.busy || !state.current) return;
  if (!await ask('¿Eliminar este ítem?', `${state.current.code} · ${state.current.brand} ${state.current.model}. También se eliminarán sus fotografías. Esta acción no se puede deshacer.`)) return;
  state.busy = true; $('#delete-item').disabled = true;
  try { await api(`/api/items/${state.current.id}?version=${state.current.version}`,{method:'DELETE'}); state.items = state.items.filter(item => item.id !== state.current.id); state.dirty = false; $('#editor').close(); render(); toast('Ítem eliminado.'); }
  catch (error) { $('#form-error').textContent = error.message; }
  finally { state.busy = false; $('#delete-item').disabled = false; }
});
// Actualizar el listado al volver a la app sin pisar una ficha abierta.
document.addEventListener('visibilitychange', () => { if (!document.hidden && !$('#app').hidden && !$('#editor').open) loadItems(); });
try { const session = await api('/api/session'); if (session.authenticated) await enterApp(); else showAuth(!session.configured); }
catch (error) { $('#loading').textContent = error.message + ' Recargá la página para reintentar.'; }
