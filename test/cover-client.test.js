import test from 'node:test';
import assert from 'node:assert/strict';
import { connect } from '../src/data.js';

test('intercambiar fotos existentes conserva los archivos y envía las referencias elegidas', async t => {
  const original = 'owner/item/original.jpg';
  const selected = 'owner/item/selected.jpg';
  const requests = [];
  t.mock.method(globalThis,'fetch',async (url,options = {}) => {
    requests.push(String(url));
    if (String(url).includes('/rpc/')) {
      const input = JSON.parse(options.body);
      assert.equal(input.p_photo_path,selected);
      assert.deepEqual(input.p_values.extra_photos,[original]);
      return Response.json({id:'item',code:'P000001',photo_path:selected,extra_photos:[original]});
    }
    assert.ok(String(url).includes('/inventory_items'));
    return Response.json([]);
  });
  const db = connect({supabaseUrl:'https://fixture.example.test',publishableKey:'sb_publishable_fixture'});
  await db.save({
    id:'item',revision:1,values:{photo_crop:null},photoPath:selected,
    previousPhotoPath:original,previousExtraPhotos:[selected],gallery:[{path:original}],userId:'editor',
  });
  assert.equal(requests.length,2);
});
