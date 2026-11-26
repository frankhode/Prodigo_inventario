import { normalize } from './core.js';
import {isTypewriter,typewriterDetails} from './machine-details.js';

const equipment = ['brand','model','date','number','type'];
const artwork = ['Autor','Título o descripción','date','Técnica','number'];
const publication = ['Título','Autor o entidad','Editorial','date'];
const documentFields = ['Título o descripción','Emisor o autor','date','number'];
const other = ['Nombre del objeto','date'];
const groups = {
  'Oficina': {
    'Máquina de escribir': [...equipment,...typewriterDetails],
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
    'Documento histórico': [...documentFields,'Clase de documento'],
    'Otro material documental': documentFields,
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

const materials = Object.assign({},...Object.values(groups));

export function materialFields(category) {
  if(isTypewriter(category))return materials['Máquina de escribir'];
  const name = Object.keys(materials).find(name => normalize(name) === normalize(category));
  return name ? materials[name] : other;
}

export function materialGroup(category) {
  if(isTypewriter(category))return 'Oficina';
  return Object.keys(groups).find(group => Object.keys(groups[group])
    .some(name => normalize(name) === normalize(category))) ?? '';
}

export function createGuidedIntake({$, onMaterial}) {
  const editor = $('#editor');
  const panel = $('#guided-fields');
  const full = $('.inventory-fields');
  const photo = $('#photo-step');
  const back = $('#guided-back');
  const skip = $('#guided-skip');
  const save = $('#next-step');
  let active = false;
  let group = '';
  let material = '';
  let screen = 'form';

  function show(target) {
    screen = target;
    const choosing = target !== 'form';
    editor.classList.toggle('guided-intake',choosing);
    editor.classList.toggle('material-intake',active && !choosing);
    panel.hidden = !choosing;
    full.hidden = photo.hidden = save.hidden = choosing;
    skip.hidden = !choosing;
    back.hidden = !active || target === 'group';
    back.textContent = choosing ? 'Volver' : 'Cambiar material';
    editor.scrollTop = 0;
    if (!choosing) {
      if (active) $('#step-caption').textContent = material || 'Sin clasificar';
      if (active) $('#step-caption').focus();
      return;
    }
    $('#step-caption').textContent = 'Nuevo objeto';
    const heading = document.createElement('h3');
    heading.textContent = target === 'group' ? '¿Qué deseás cargar?' : group;
    heading.tabIndex = -1;
    const list = document.createElement('div');
    list.className = 'guided-choices';
    const choices = target === 'group' ? Object.keys(groups) : Object.keys(groups[group]);
    for (const value of choices) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'button secondary';
      button.textContent = value;
      button.addEventListener('click',() => {
        if (target === 'group') {
          group = value;
          show('material');
        } else choose(value);
      });
      list.append(button);
    }
    panel.replaceChildren(heading,list);
    heading.focus();
  }

  function choose(value) {
    material = value;
    onMaterial(value);
    show('form');
  }
  back.addEventListener('click',() => show(screen === 'form' && group ? 'material' : 'group'));
  skip.addEventListener('click',() => {
    if (screen === 'group') group = '';
    choose('');
  });

  return {
    start(enabled) {
      active = enabled;
      group = material = '';
      show(enabled ? 'group' : 'form');
    },
    get active() { return active; },
    get choosing() { return active && screen !== 'form'; },
    get material() { return material; },
    get group() { return group; },
  };
}
