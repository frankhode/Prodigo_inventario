import {test} from 'node:test';
import assert from 'node:assert/strict';
import {machineDetails,isTypewriter,legacyVersion,typewriterForm} from '../src/machine-details.js';
import {materialFields,materialGroup} from '../src/guided-intake.js';
test('la carga asistida de máquinas usa los campos independientes, incluso categorías plurales antiguas',()=>{
  assert.ok(isTypewriter('Máquinas de escribir'));
  assert.equal(materialGroup('Máquinas de escribir'),'Oficina');
  assert.deepEqual(materialFields('Máquinas de escribir'),['brand','model','date','number','type','Color','País','Idioma del teclado','Tipo']);
});
test('convierte las etiquetas combinadas al editar conservando la información y los campos no relacionados',()=>{
  assert.deepEqual(machineDetails({'Versión / país':'Italia',Teclado:'QWERTZ',Color:'Verde',Otro:'Valor'}),{Color:'Verde',Otro:'Valor',País:'Italia','Idioma del teclado':'','Distribución del teclado':'QWERTZ'});
  assert.deepEqual(machineDetails({'Versión / país':'Segunda serie',Teclado:'Español'}),{'Versión / país (dato anterior)':'Segunda serie','Idioma del teclado':'Español','Distribución del teclado':''});
  assert.deepEqual(machineDetails({'Versión / país':'Italia','País':''}),{'País':'','Versión / país (dato anterior)':'Italia'});
  assert.equal(legacyVersion({'Versión / país':'Segunda serie'}),'Segunda serie');
});

test('tipo de máquina es independiente de versión, idioma y distribución del teclado',()=>{
  const legacy=typewriterForm({type:'Portátil',guided_details:{fields:{'Versión / país':'Segunda serie',Teclado:'QWERTZ'}}});
  assert.equal(legacy.fields.Tipo,'Portátil');
  assert.equal(legacy.version,'Segunda serie');
  assert.equal(legacy.fields['Distribución del teclado'],'QWERTZ');
  const explicit=typewriterForm({type:'Portátil',guided_details:{fields:{Tipo:'', 'Idioma del teclado':'Español'}}});
  assert.equal(explicit.fields.Tipo,'');
  assert.equal(explicit.version,'Portátil');
  const current=typewriterForm({type:'Serie 2',guided_details:{fields:{Tipo:'De escritorio', 'Distribución del teclado':'QWERTY'}}});
  assert.equal(current.version,'Serie 2');
  assert.equal(current.fields.Tipo,'De escritorio');
  assert.equal(current.fields['Distribución del teclado'],'QWERTY');
});
