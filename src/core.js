export const destinations = { museo: 'Museo', tienda: 'Tienda', otros: 'Otros' };
export const normalize = value => String(value ?? '').toLocaleLowerCase('es').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
export const fields = ['category','brand','model','manufacture_date','type','destination','notes'];
export const title = item => [item.brand,item.model].filter(Boolean).join(' ') || item.category;
export const photoName = item => `${item.code}.jpg`;
export function validate(values) {
  if (!values.category?.trim()) throw Error('Elegí el objeto.');
  if (values.model?.trim() && !values.brand?.trim()) throw Error('Elegí una marca antes de consignar el modelo.');
  if (!destinations[values.destination]) throw Error('Elegí un destino.');
  for (const field of fields) {
    const max = field === 'notes' ? 4000 : field === 'manufacture_date' ? 80 : 120;
    if (typeof values[field] !== 'string' || values[field].length > max) throw Error('Revisá la extensión de los campos.');
  }
  return Object.fromEntries(fields.map(field => [field,values[field].trim()]));
}
export function csv(items) {
  const columns = ['Identificador','Objeto','Marca','Modelo','Fecha','Tipo','Destino','Notas','Foto','Alta','Modificación','Creado por','Modificado por'];
  // Evitar que Excel interprete como fórmulas los valores ingresados por usuarios.
  const cell = value => '"' + String(value ?? '').replace(/^[\s\u0000-\u001f]*[=+@-]/, match => "'" + match).replaceAll('"','""') + '"';
  const rows = items.map(i => [i.code,i.category,i.brand,i.model,i.manufacture_date,i.type,destinations[i.destination],i.notes,photoName(i),i.created_at,i.updated_at,i.created_by,i.updated_by]);
  return '\ufeff' + [columns,...rows].map(row => row.map(cell).join(';')).join('\r\n');
}
export function exportRecord(item) {
  return { ...item, photo_file: `fotos/${photoName(item)}` };
}
