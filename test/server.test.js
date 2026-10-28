import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

let child, dir, base, setupToken, cookie;
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const item = { brand:'Olivetti',model:'Lettera 22',date:'ca. 1950',type:'Mecánica portátil',destination:'museo',notes:'Serie 123 · Árgentina',photos:[{data:image}] };
async function start() {
  let output = ''; child = spawn(process.execPath,['server.js'], { cwd:new URL('..',import.meta.url), env:{...process.env,PORT:'0',HOST:'127.0.0.1',DATA_DIR:dir},stdio:['ignore','pipe','pipe'] });
  const ready = new Promise((resolve,reject) => {
    const timeout = setTimeout(() => reject(new Error(`No arrancó el servidor: ${output}`)),10000);
    child.on('error',reject); child.stdout.on('data', chunk => {
      output += chunk; const port = /puerto (\d+)/.exec(output)?.[1]; const token = /una sola vez\): (\w+)/.exec(output)?.[1];
      if (port && (cookie || token)) { clearTimeout(timeout); base = `http://127.0.0.1:${port}`; setupToken = token; resolve(); }
    });
  }); await ready;
}
async function stop() { const ended = once(child,'exit'); child.kill('SIGTERM'); await ended; }
async function request(url,method='GET',body,authenticated=true,headers={}) {
  return fetch(base+url, {method,headers:{'Content-Type':'application/json','X-Requested-With':'prodigo',...(authenticated && cookie ? {Cookie:cookie} : {}),...headers},...(body ? {body:JSON.stringify(body)} : {})});
}
before(async () => { dir = await mkdtemp(path.join(tmpdir(),'prodigo-test-')); await start(); });
after(async () => { if (child && child.exitCode === null) await stop(); await rm(dir,{recursive:true,force:true}); });
test('inventario completo, protección y persistencia',async t => {
  let created;
  await t.test('protege los datos y requiere código de instalación',async () => {
    assert.equal((await request('/api/items')).status,401);
    assert.equal((await request('/api/setup','POST',{token:'inventado',password:'prueba-segura'})).status,403);
    const response = await request('/api/setup','POST',{token:setupToken,password:' prueba-segura '});
    assert.equal(response.status,201); cookie = response.headers.get('set-cookie').split(';')[0];
    assert.match(response.headers.get('set-cookie'),/HttpOnly/);
    assert.equal((await request('/api/setup','POST',{token:setupToken,password:'otra-clave-larga'})).status,409);
  });
  await t.test('valida campos, destino, tamaño y contenido de las fotos',async () => {
    for (const invalid of [{...item,brand:' '},{...item,destination:'venta'},{...item,photos:[{data:'data:image/png;base64,aW52YWxpZG8='}]},{...item,photos:Array(6).fill({data:image})},{...item,photos:[{id:'no-es-de-este-item.jpg'}]}]) {
      assert.equal((await request('/api/items','POST',invalid)).status,400);
    }
    assert.deepEqual(await readdir(path.join(dir,'photos')),[]);
    assert.equal((await request('/api/items','POST',item,true,{'X-Requested-With':'otro'})).status,403);
    assert.equal((await request('/api/items','POST',item,true,{Origin:'https://otro.ejemplo'})).status,403);
  });
  await t.test('guarda, lista, sirve y protege fotografías',async () => {
    const response = await request('/api/items','POST',item); assert.equal(response.status,201); created = await response.json();
    assert.equal(created.code,'PRO-00001'); assert.equal(created.date,'ca. 1950'); assert.equal(created.photos.length,1);
    assert.equal((await request(created.photos[0].url,'GET',null,false)).status,401);
    const photo = await request(created.photos[0].url); assert.equal(photo.headers.get('content-type'),'image/png'); assert.equal((await photo.arrayBuffer()).byteLength,68);
    assert.equal((await (await request('/api/items')).json()).items.length,1);
  });
  await t.test('edita sin duplicar fotos y detecta cambios simultáneos',async () => {
    const edited = await request(`/api/items/${created.id}`,'PUT',{...item,model:'Lettera 32',photos:created.photos,version:1});
    assert.equal(edited.status,200); const data = await edited.json(); assert.equal(data.version,2);
    assert.equal((await request(`/api/items/${created.id}`,'PUT',{...item,photos:created.photos,version:1})).status,409);
    assert.equal((await readdir(path.join(dir,'photos'))).length,1);
    assert.equal((await request(`/api/items/${created.id}?version=1`,'DELETE')).status,409);
  });
  await t.test('exporta texto español y neutraliza fórmulas en CSV',async () => {
    await request('/api/items','POST',{...item,brand:'=SUM(A1)',photos:[]});
    const response = await request('/api/export.csv'); const csv = await response.text();
    assert.match(csv,/Olivetti/); assert.match(csv,/Árgentina/); assert.match(csv,/'=SUM\(A1\)/);
  });
  await t.test('conserva base, fotos y sesión después de reiniciar',async () => {
    await stop(); await start();
    const response = await request('/api/items'); assert.equal(response.status,200); assert.equal((await response.json()).items.length,2);
    assert.equal((await request(created.photos[0].url)).status,200);
  });
  await t.test('elimina fotografías al reemplazar y borrar',async () => {
    assert.equal((await request(`/api/items/${created.id}`,'PUT',{...item,photos:[],version:2})).status,200);
    assert.equal((await request(created.photos[0].url)).status,404); assert.deepEqual(await readdir(path.join(dir,'photos')),[]);
    await request(`/api/items/${created.id}`,'PUT',{...item,version:3});
    assert.equal((await readdir(path.join(dir,'photos'))).length,1);
    assert.equal((await request(`/api/items/${created.id}?version=4`,'DELETE')).status,200);
    assert.deepEqual(await readdir(path.join(dir,'photos')),[]);
    const next = await (await request('/api/items','POST',{...item,photos:[]})).json(); assert.equal(next.code,'PRO-00003');
  });
  await t.test('cierra sesión y permite ingresar nuevamente',async () => {
    assert.equal((await request('/api/logout','POST',{})).status,200);
    assert.equal((await request('/api/items')).status,401);
    assert.equal((await request('/api/login','POST',{password:'incorrecta'},false)).status,401);
    assert.equal((await request('/api/login','POST',{password:' prueba-segura '},false)).status,200);
  });
});
