import test from 'node:test';
import assert from 'node:assert/strict';
import { compressFrame, PHOTO_LIMIT, compressPhoto } from '../src/photos.js';
import { Camera } from '../src/camera.js';

function cameraFixture(getUserMedia) {
  const video = {srcObject:null,pause(){},async play(){}};
  const camera = new Camera(video,{getUserMedia});
  return {video,camera};
}
function streamFixture() {
  let stopped = 0;
  return {stream:{getTracks:() => [{stop(){stopped++;}}]},stopped:() => stopped};
}
test('camera requests bounded video without audio, then releases the camera',async () => {
  const fixture = streamFixture(); let constraints;
  const {camera,video} = cameraFixture(async options => { constraints = options; return fixture.stream; });
  assert.equal(await camera.start(),true);
  assert.equal(constraints.audio,false);
  assert.ok(constraints.video.width.max <= 1280 && constraints.video.height.max <= 1280);
  assert.equal(constraints.video.facingMode.ideal,'environment');
  assert.equal(video.srcObject,fixture.stream);
  camera.stop(); assert.equal(fixture.stopped(),1); assert.equal(video.srcObject,null);
});
test('cancel during permission prompt stops a late stream without attaching it',async () => {
  const fixture = streamFixture(); let permit;
  const {camera,video} = cameraFixture(() => new Promise(resolve => permit = resolve));
  const opening = camera.start(); camera.stop(); permit(fixture.stream);
  assert.equal(await opening,false); assert.equal(fixture.stopped(),1); assert.equal(video.srcObject,null);
});
test('an old permission request cannot replace or stop a newer camera',async () => {
  const old = streamFixture(), current = streamFixture(); let permit; let calls = 0;
  const {camera,video} = cameraFixture(() => ++calls === 1 ? new Promise(resolve => permit = resolve) : Promise.resolve(current.stream));
  const first = camera.start(); assert.equal(await camera.start(),true);
  permit(old.stream); assert.equal(await first,false);
  assert.equal(old.stopped(),1); assert.equal(current.stopped(),0); assert.equal(video.srcObject,current.stream);
  camera.stop();
});
test('a failed video playback releases the active stream',async () => {
  const fixture = streamFixture(); const {camera,video} = cameraFixture(async () => fixture.stream);
  video.play = async () => { throw Error('Playback failed'); };
  await assert.rejects(camera.start(),/Playback failed/);
  assert.equal(fixture.stopped(),1); assert.equal(video.srcObject,null);
});

test('large landscape and portrait frames use at most 1200 px and release canvas memory',async t => {
  const original = globalThis.document;
  t.after(() => { if (original === undefined) delete globalThis.document; else globalThis.document = original; });
  for (const [width,height] of [[8000,6000],[6000,8000]]) {
    const sizes = [];
    const canvas = {width:0,height:0,getContext:() => ({fillRect(){},drawImage(){}}),
      toBlob(callback,type){sizes.push([canvas.width,canvas.height]); callback(new Blob(['jpeg'],{type}));}};
    globalThis.document = {createElement:() => canvas};
    const blob = await compressFrame({},width,height);
    assert.equal(blob.type,'image/jpeg'); assert.ok(blob.size <= PHOTO_LIMIT);
    assert.equal(Math.max(...sizes[0]),1200);
    assert.equal(sizes[0][0]/sizes[0][1],width/height);
    assert.equal(canvas.width,0); assert.equal(canvas.height,0);
  }
});
test('complex photos shrink until they meet storage limits; failures free buffers',async t => {
  const original = globalThis.document;
  t.after(() => { if (original === undefined) delete globalThis.document; else globalThis.document = original; });
  const sizes = []; let fail = false;
  const canvas = {width:0,height:0,getContext:() => ({fillRect(){},drawImage(){}}),
    toBlob(callback,type){sizes.push(canvas.width);callback(fail ? null : new Blob([new Uint8Array(canvas.width > 1000 ? PHOTO_LIMIT+1 : 1000)],{type}));}};
  globalThis.document = {createElement:() => canvas};
  assert.ok((await compressFrame({},8000,6000)).size <= PHOTO_LIMIT);
  assert.deepEqual(sizes,[1200,1200,1200,936]); assert.equal(canvas.width,0);
  fail = true; await assert.rejects(compressFrame({},8000,6000),/No se pudo reducir/);
  assert.equal(canvas.width,0); assert.equal(canvas.height,0);
});
test('gallery decode failure releases image and object URL',async t => {
  const original = globalThis.Image; const image = {src:'',async decode(){throw Error('Unsupported');}};
  globalThis.Image = function(){return image;};
  t.after(() => { if (original === undefined) delete globalThis.Image; else globalThis.Image = original; });
  t.mock.method(URL,'createObjectURL',() => 'blob:test'); const revoked = t.mock.method(URL,'revokeObjectURL',() => {});
  await assert.rejects(compressPhoto(new Blob(['bad'])),/No se pudo abrir/);
  assert.equal(image.src,''); assert.equal(revoked.mock.calls[0].arguments[0],'blob:test');
});
