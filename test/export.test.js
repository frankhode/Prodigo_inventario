import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csv, exportRecord, validate } from '../src/core.js';
const item = {code:'P000042',category:'Fotografía',brand:'',model:'',manufacture_date:'ca. 1930',type:'Retrato',destination:'museo',notes:'Texto; con "comillas"\ny salto',created_by:'u1',updated_by:'u2'};
test('Exportación conserva fecha aproximada, campos vacíos, comillas, saltos y nombre estable de foto',() => {
  const data = csv([item]); assert.match(data,/ca\. 1930/); assert.match(data,/"Texto; con ""comillas""\ny salto"/);
  assert.match(data,/P000042\.jpg/); assert.equal(exportRecord(item).photo_file,'fotos/P000042.jpg');
});
test('Excel no ejecuta fórmulas ingresadas en campos de texto',() => {
  assert.ok(csv([{...item,notes:'=HYPERLINK("https://ejemplo")'}]).includes("'=HYPERLINK"));
  assert.ok(csv([{...item,notes:'  @SUM(1)'}]).includes("'  @SUM"));
});
test('Una fotografía no necesita marca ni modelo',() => {
  assert.equal(validate(item).brand,'');
  assert.throws(() => validate({...item,model:'Modelo sin marca'}),/marca antes/);
});
