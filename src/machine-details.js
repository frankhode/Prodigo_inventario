import {normalize} from './core.js';
export const isTypewriter=category=>/^maquinas? (?:de )?escribir$/.test(normalize(category).trim().replace(/\s+/g,' '));
export const typewriterDetails=['Sistema de funcionamiento','Color','País','Idioma del teclado','Tipo'];
export const operatingSystems=['Mecánico','Electromecánico','Electrónico'];
export const typewriterTypes=['Portátil','Escritorio','Ultraportátil'];
const isLegacyType=value=>/^(?:de escritorio|escritorio|portatil|ultraportatil)$/.test(normalize(value).trim());
const countries=['Argentina','Estados Unidos','Italia','Alemania','Reino Unido','Francia','Suiza','Japón','España'];
const languages=['Español','Inglés','Francés','Alemán','Italiano','Portugués'];
const match=(values,input)=>values.find(option=>normalize(option)===normalize(input))||'';
export function legacyVersion(fields={}){
  const combined=String(fields?.['Versión / país']??'').trim();
  return match(countries,combined)?'':combined;
}
export function machineDetails(fields={}){
  const result={...fields};
  const combined=String(result['Versión / país']??'').trim();
  const keyboard=String(result.Teclado??'').trim();
  const country=match(countries,combined),language=match(languages,keyboard);
  if(!Object.hasOwn(result,'País')){
    if(Object.hasOwn(result,'País de fabricación'))result['País']=result['País de fabricación'];
    else if(country)result['País']=country;
  }
  if(combined&&(!country||result.País!==country)){
    if(!Object.hasOwn(result,'Versión / país (dato anterior)'))result['Versión / país (dato anterior)']=combined;
  }
  delete result['País de fabricación'];
  if(keyboard){
    if(!Object.hasOwn(result,'Idioma del teclado'))result['Idioma del teclado']=language;
    if(!Object.hasOwn(result,'Distribución del teclado'))result['Distribución del teclado']=language?'':keyboard;
  }
  delete result['Versión / país'];delete result.Teclado;
  return result;
}

// The historical type column is currently the version. Recognize the original
// machine classifications only when there is no explicit new Tipo field yet.
export function typewriterForm(item={}){
  const fields=machineDetails(item.guided_details?.fields);
  const stored=String(item.type??'').trim();
  const explicit=Object.hasOwn(fields,'Tipo');
  const legacyType=!explicit&&isLegacyType(stored);
  if(!explicit)fields.Tipo=legacyType?stored:'';
  return {fields,version:explicit?stored:(!legacyType&&stored)||legacyVersion(item.guided_details?.fields)};
}
