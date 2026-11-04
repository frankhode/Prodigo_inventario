import test from 'node:test';
import assert from 'node:assert/strict';
import { squareCrop, validCrop } from '../src/photo-crop.js';
import { handleCatalog } from '../supabase/functions/museum-catalog/index.js';

test('el recorte es cuadrado en fotos horizontales y verticales y queda dentro de la imagen', () => {
  for (const [width,height] of [[1200,800],[800,1200]]) {
    const crop = squareCrop(width,height,.02,.98,.5);
    assert.ok(validCrop(crop));
    assert.equal(crop[0],0);
    assert.equal(crop[1]+crop[3],1);
    assert.equal(crop[2]*width,crop[3]*height);
  }
});

test('el catálogo devuelve el recorte de museo y sigue disponible antes de aplicar el SQL', async () => {
  const fields = [];
  const row = {code:'P000001',photo_crop:[.1,.2,.3,.4]};
  const env = name => ({SUPABASE_URL:'https://fixture.example.test/',SUPABASE_SERVICE_ROLE_KEY:'fixture'})[name];
  let migrated = true;
  const fetchImpl = async url => {
    assert.equal(url.searchParams.get('destination'),'eq.museo');
    const selected = url.searchParams.get('select');
    fields.push(selected);
    if (selected.includes('photo_crop') && !migrated) return Response.json({code:'42703'},{status:400});
    return Response.json([migrated ? row : {code:row.code}]);
  };
  const request = new Request('https://fixture.example.test/functions/v1/museum-catalog');
  const fetchCatalog = async () => (await handleCatalog(request,{env,fetchImpl})).json();
  assert.deepEqual((await fetchCatalog()).items,[row]);
  migrated = false;
  assert.deepEqual((await fetchCatalog()).items,[{code:row.code}]);
  assert.match(fields[1],/photo_crop/);
  assert.doesNotMatch(fields.at(-1),/photo_crop/);
});

test('la galería pública expone el total y solo sirve fotos de fichas del museo', async () => {
  const secretPath = 'private/item/additional.jpg';
  const env = name => ({SUPABASE_URL:'https://fixture.example.test/',SUPABASE_SERVICE_ROLE_KEY:'fixture'})[name];
  const fetchImpl = async url => {
    if (url.pathname.startsWith('/storage/')) {
      assert.ok(url.pathname.endsWith('/'+secretPath));
      return new Response('jpeg');
    }
    assert.equal(url.searchParams.get('destination'),'eq.museo');
    if (url.searchParams.get('code') === 'eq.P000002') return Response.json([]);
    return Response.json([{code:'P000001',extra_photos:[secretPath]}]);
  };
  const request = (query = '') => handleCatalog(new Request('https://fixture.example.test/catalog'+query),{env,fetchImpl});
  const listing = await (await request()).json();
  assert.deepEqual(listing.items,[{code:'P000001',photo_count:2}]);
  assert.equal(await (await request('?foto=P000001&imagen=2')).text(),'jpeg');
  assert.equal((await request('?foto=P000002&imagen=2')).status,404);
  assert.equal((await request('?foto=P000001&imagen=3')).status,404);
  assert.equal((await request('?foto=P000001&imagen=9')).status,400);
});
