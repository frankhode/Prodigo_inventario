import { normalize } from './core.js';

const equipment = ['brand','model','date','number','type'];
const artwork = ['Autor','Título o descripción','date','Técnica','number'];
const publication = ['Título','Autor o entidad','Editorial','date'];
const document = ['Título o descripción','Emisor o autor','date','number'];
const other = ['Nombre del objeto','date'];
const groups = {
  'Oficina': {
    'Máquina de escribir': equipment,
    'Mimeógrafo': equipment,
    'Calculadora o sumadora': equipment,
    'Objeto de oficina o librería': ['Nombre del objeto','brand','date','type'],
    'Mobiliario': ['Nombre del objeto','brand','date','type'],
    'Velador': equipment,
    'Otro objeto de oficina': other,
  },
  'Fotografía, arte y cuadros': {
    'Fotografía': ['Fotógrafo o estudio','Tema o retratado','date','Formato','number'],
    'Cámara fotográfica': equipment,
    'Equipo o accesorio fotográfico': equipment,
    'Obra de arte o cuadro': artwork,
    'Otro material de fotografía o arte': other,
  },
  'Material bibliográfico': {
    Libro: publication, Manual: publication, 'Catálogo comercial': publication,
    'Revista o publicación periódica': [...publication,'number'],
    'Otro material bibliográfico': publication,
  },
  'Material documental': {
    Postal: ['Lugar o tema','Autor o editor','date','number'],
    Correspondencia: ['Remitente','Destinatario','date'],
    Publicidad: ['Marca o anunciante','Producto o servicio','date','Medio'],
    'Recorte de prensa': ['Título o tema','Medio','date'],
    'Documento histórico': [...document,'Clase de documento'],
    'Otro material documental': document,
  },
  'Museografía': {
    'Objeto histórico fechado': ['Nombre del objeto','date','Procedencia'],
    'Objeto de contextualización histórica': ['Nombre del objeto','Contexto histórico','date'],
    'Complemento de exhibición': ['Nombre del objeto','Exhibición o uso','date'],
  },
  'Investigación y fuentes': {
    Hipótesis: ['Tema','Fuente','Referencia al catalogador'],
    'Información o fuente': ['Tema','Fuente','date','Referencia al catalogador'],
    'Recopilación en proceso': ['Tema','Fuente','Referencia al catalogador'],
  },
};

export function createGuidedIntake({$, fillCombo, comboValue, markDirty}) {
  const form = $('#item-form');
  const panel = $('#guided-fields');
  const editor = $('#editor');
  const back = $('#guided-back');
  const next = $('#guided-next');
  const save = $('#next-step');
  const photo = $('#photo-step');
  const full = $('.inventory-fields');
  let active = false;
  let step = 0;
  let group = '';
  let details = {};
  let path = [];

  const nativeFields = {
    brand: ['Marca','#brand-select'], model: ['Modelo','#model-select'],
    type: ['Tipo','#type-select'], date: ['Fecha','#manufacture-date'],
    number: ['Numeración original','#original-number'],
  };
  const caption = {
    group: '¿Qué deseás cargar?', material: 'Tipo de material',
    destination: 'Destino', notes: 'Notas', photo: 'Fotos y revisión',
  };
  const choices = { museo:'Museo', tienda:'Tienda', otros:'Otros' };
  function node(tag, text = '') {
    const result = document.createElement(tag);
    result.textContent = text;
    return result;
  }
  function selectMaterial(value) {
    for (const field of ['category','brand','model','type']) fillCombo(field,field === 'category' ? value : '');
    for (const selector of ['#manufacture-date','#original-number']) $(selector).value = '';
    details = {};
  }
  function buildPath() {
    const category = comboValue('category');
    const configured = Object.values(groups).find(materials => Object.hasOwn(materials,category))?.[category];
    const fields = (configured ?? other).map(key => nativeFields[key] ? {key,native:true} : {key,label:key});
    path = [{key:'group'},{key:'material'},...fields,...['destination','notes','photo'].map(key=>({key}))];
  }
  function addChoices(entries, current, choose) {
    const list = node('div');
    list.className = 'guided-choices';
    for (const [value,label] of entries) {
      const button = node('button',label);
      button.type = 'button';
      button.className = 'button secondary';
      button.setAttribute('aria-pressed',String(value === current));
      button.addEventListener('click',() => {
        choose(value);
        markDirty();
        move(1);
      });
      list.append(button);
    }
    panel.append(list);
    return list;
  }
  function addInput(label, control, receive) {
    control.id = 'guided-input';
    const field = node('label',label);
    field.htmlFor = control.id;
    field.append(control);
    control.addEventListener('input',() => receive(control.value));
    panel.append(field);
  }
  function renderNative(key) {
    const [label, selector] = nativeFields[key];
    const original = $(selector);
    if (original.tagName !== 'SELECT') {
      const input = original.cloneNode();
      input.value = original.value;
      addInput(label,input,value => { original.value = value; });
      return;
    }
    const list = addChoices([...original.options].filter(option => option.value && option.value !== '__new__')
      .map(option => [option.value,option.text]),comboValue(key),value => {
      const changed = comboValue(key) !== value;
      fillCombo(key,value);
      if (key === 'brand' && changed) fillCombo('model');
    });
    const input = node('input');
    input.maxLength = 120;
    input.placeholder = 'Escribí para agregar una opción';
    input.value = comboValue(key);
    addInput(`Buscar o agregar ${label.toLowerCase()}`,input,value => {
      const changed = comboValue(key) !== value.trim();
      fillCombo(key,value.trim());
      if (key === 'brand' && changed) fillCombo('model');
      for (const button of list.children) button.hidden = !normalize(button.textContent).includes(normalize(value.trim()));
    });
    panel.append(list);
  }
  function render() {
    const {key,native,label} = path[step];
    const heading = node('h3',native ? nativeFields[key][0] : label ?? caption[key]);
    heading.tabIndex = -1;
    panel.replaceChildren(heading);
    photo.hidden = key !== 'photo';
    back.hidden = step === 0;
    save.hidden = key !== 'photo';
    next.hidden = key === 'photo';
    $('#guided-skip').hidden = key === 'photo';
    next.hidden ||= key === 'group' || (key === 'material' && Boolean(group)) || key === 'destination';
    $('#step-caption').textContent = `${step + 1} de ${path.length}`;
    if (key === 'group') addChoices(Object.keys(groups).map(name=>[name,name]),group,value => {
      if (group !== value) selectMaterial('');
      group = value;
    });
    else if (key === 'material') {
      const entries = group
        ? Object.keys(groups[group]).map(name=>[name,name])
        : [...$('#category-select').options].filter(option => option.value && option.value !== '__new__')
          .map(option => [option.value,option.text]);
      const list = addChoices(entries,comboValue('category'),value => {
        if (comboValue('category') !== value) selectMaterial(value);
      });
      if (!group) {
        const input = node('input');
        input.maxLength = 120;
        input.value = comboValue('category');
        addInput('Buscar o escribir el material',input,value => {
          selectMaterial(value.trim());
          for (const button of list.children) button.hidden = !normalize(button.textContent).includes(normalize(value.trim()));
        });
        panel.append(list);
      }
    } else if (native) renderNative(key);
    else if (key === 'destination') addChoices(Object.entries(choices),form.elements.destination.value,value => {
      form.elements.destination.value = value;
    });
    else if (key === 'notes') {
      const input = node('textarea');
      input.rows = 3;
      input.maxLength = 4000;
      input.value = $('#notes').value;
      addInput('Observaciones',input,value => { $('#notes').value = value; });
    } else if (key === 'photo') {
      panel.append(node('p',[group,comboValue('category') || 'Sin clasificar'].filter(Boolean).join(' · ')));
      const summary = node('dl');
      summary.className = 'review';
      for (const field of path) {
        let value = details[field.label];
        let label = field.label;
        if (field.native) {
          const [name, selector] = nativeFields[field.key];
          label = name;
          value = $(selector).tagName === 'SELECT' ? comboValue(field.key) : $(selector).value.trim();
        }
        if (field.key === 'destination') { label = 'Destino'; value = choices[form.elements.destination.value]; }
        if (field.key === 'notes') { label = 'Notas'; value = $('#notes').value.trim(); }
        if (value) summary.append(node('dt',label),node('dd',value));
      }
      if (summary.children.length) panel.append(summary);
    } else {
      const input = node('input');
      input.maxLength = 240;
      input.value = details[label] ?? '';
      addInput(label,input,value => { details[label] = value.trim(); });
    }
    editor.scrollTop = 0;
    heading.focus();
  }
  function move(direction) {
    buildPath();
    step = Math.max(0,Math.min(path.length - 1,step + direction));
    render();
  }
  function skip() {
    const {key,label} = path[step];
    if (key === 'group') {
      if (group) selectMaterial('');
      group = '';
    } else if (key === 'material') selectMaterial('');
    else if (key === 'destination') form.elements.destination.value = '';
    else if (key === 'notes') $('#notes').value = '';
    else if (nativeFields[key]) {
      const control = $(nativeFields[key][1]);
      if (control.tagName === 'SELECT') fillCombo(key);
      else control.value = '';
    } else delete details[label];
    markDirty();
    move(1);
  }
  panel.addEventListener('keydown',event => {
    if (event.key !== 'Enter' || event.target.tagName !== 'INPUT' || event.isComposing) return;
    event.preventDefault();
    move(1);
  });
  back.addEventListener('click',() => move(-1));
  next.addEventListener('click',() => move(1));
  $('#guided-skip').addEventListener('click',skip);
  return {
    start(enabled) {
      active = enabled;
      group = '';
      details = {};
      step = 0;
      editor.classList.toggle('guided-intake',enabled);
        full.hidden = enabled;
      panel.hidden = !enabled;
      photo.hidden = false;
      back.hidden = next.hidden = $('#guided-skip').hidden = !enabled;
      save.hidden = false;
      if (enabled) { buildPath(); render(); }
    },
    get active() { return active; },
    get reviewing() { return path[step]?.key === 'photo'; },
    advance() { move(1); },
    values() {
      return {group,fields:Object.fromEntries(Object.entries(details).filter(([,value]) => value))};
    },
  };
}
