export const destinations = { museo: 'Museo', tienda: 'Tienda', otros: 'Otros' };
export const normalize = value => String(value ?? '').toLocaleLowerCase('es').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
export const fields = ['category','brand','model','manufacture_date','original_number','type','destination','notes'];
export const title = item => [item.brand,item.model].filter(Boolean).join(' ')
  || item.guided_details?.fields?.['Título'] || item.guided_details?.fields?.['Título o descripción']
  || item.guided_details?.fields?.['Nombre del objeto'] || item.guided_details?.fields?.['Tema'] || item.category;
export const photoName = item => item.photo_path === null ? '' : `${item.code}.jpg`;
export function photoFiles(item) {
  return [
    ...(photoName(item) ? [{path:item.photo_path,name:`fotos/${photoName(item)}`}] : []),
    ...(item.extra_photos ?? []).map((path,index) => ({path,name:`fotos/${item.code}-${index+2}.jpg`})),
  ];
}
export function validate(values,{guided = false} = {}) {
  if (!values.category?.trim()) throw Error('Elegí el objeto.');
  if (!guided && values.model?.trim() && !values.brand?.trim()) throw Error('Elegí una marca antes de consignar el modelo.');
  if ((!guided || values.destination) && !destinations[values.destination]) throw Error('Elegí un destino.');
  values = {...values,original_number:values.original_number ?? ''};
  for (const field of fields) {
    const max = field === 'notes' ? 4000 : field === 'manufacture_date' ? 80 : 120;
    if (typeof values[field] !== 'string' || values[field].length > max) throw Error('Revisá la extensión de los campos.');
  }
  return Object.fromEntries(fields.map(field => [field,values[field].trim()]));
}
export function csv(items) {
  const columns = ['Identificador','Objeto','Marca','Modelo','Fecha','N.º de serie / numeración original','Tipo','Destino','Notas','Foto','Alta','Modificación','Creado por','Modificado por','Fotos adicionales','Estado de etiquetado','Fecha de etiquetado','Etiqueta confirmada por','Grupo','Datos del material'];
  // Evitar que Excel interprete como fórmulas los valores ingresados por usuarios.
  const cell = value => '"' + String(value ?? '').replace(/^[\s\u0000-\u001f]*[=+@-]/, match => "'" + match).replaceAll('"','""') + '"';
  const rows = items.map(i => [i.code,i.category,i.brand,i.model,i.manufacture_date,i.original_number,i.type,destinations[i.destination],i.notes,photoName(i),i.created_at,i.updated_at,i.created_by,i.updated_by,photoFiles(i).slice(photoName(i) ? 1 : 0).map(file => file.name).join(', '),i.label_confirmed_at ? 'Etiquetado' : 'Pendiente',i.label_confirmed_at ?? '',i.label_confirmed_by ?? '',i.guided_details?.group,Object.entries(i.guided_details?.fields ?? {}).map(([label,value]) => `${label}: ${value}`).join('\n')]);
  return '\ufeff' + [columns,...rows].map(row => row.map(cell).join(';')).join('\r\n');
}
export function exportRecord(item) {
  return { ...item, original_number: item.original_number ?? '', photo_file: photoName(item) ? `fotos/${photoName(item)}` : null, extra_photo_files: photoFiles(item).slice(photoName(item) ? 1 : 0).map(file => file.name) };
}
