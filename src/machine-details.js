import {normalize} from './core.js';
export const isTypewriter=category=>/^maquinas? (?:de )?escribir$/.test(normalize(category).trim().replace(/\s+/g,' '));
export const typewriterDetails=['Color','País','Idioma del teclado','Distribución del teclado'];
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
