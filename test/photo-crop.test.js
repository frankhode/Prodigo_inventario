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
  assert.doesNotMatch(fields[2],/photo_crop/);
});
