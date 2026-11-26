import {test} from 'node:test';
import assert from 'node:assert/strict';
import {machineDetails,isTypewriter,legacyVersion} from '../src/machine-details.js';
import {materialFields,materialGroup} from '../src/guided-intake.js';
test('la carga asistida de máquinas usa los campos independientes, incluso categorías plurales antiguas',()=>{
  assert.ok(isTypewriter('Máquinas de escribir'));
  assert.equal(materialGroup('Máquinas de escribir'),'Oficina');
  assert.deepEqual(materialFields('Máquinas de escribir'),['brand','model','date','number','type','Color','País','Idioma del teclado','Distribución del teclado']);
});
test('convierte las etiquetas combinadas al editar conservando la información y los campos no relacionados',()=>{
  assert.deepEqual(machineDetails({'Versión / país':'Italia',Teclado:'QWERTZ',Color:'Verde',Otro:'Valor'}),{Color:'Verde',Otro:'Valor',País:'Italia','Idioma del teclado':'','Distribución del teclado':'QWERTZ'});
  assert.deepEqual(machineDetails({'Versión / país':'Segunda serie',Teclado:'Español'}),{'Versión / país (dato anterior)':'Segunda serie','Idioma del teclado':'Español','Distribución del teclado':''});
  assert.deepEqual(machineDetails({'Versión / país':'Italia','País':''}),{'País':'','Versión / país (dato anterior)':'Italia'});
  assert.equal(legacyVersion({'Versión / país':'Segunda serie'}),'Segunda serie');
});
