export const PHOTO_LIMIT = 150 * 1024;

// Recortar en el centro para que la captura coincida con la vista previa (object-fit: cover).
export function cameraCrop(width, height, ratio) {
  if (!width || !height) throw Error('La cámara todavía no está lista. Esperá un momento y volvé a intentar.');
  const target = {'1:1': 1, '9:16': 9/16}[ratio];
  if (!target) throw Error('Formato de cámara no reconocido.');
  if (width/height > target) {
    const cropWidth = height * target;
    return {x:(width-cropWidth)/2, y:0, width:cropWidth, height};
  }
  const cropHeight = width / target;
  return {x:0, y:(height-cropHeight)/2, width, height:cropHeight};
}
// Both camera frames and files use a small canvas; never create a full-size camera canvas.
export async function compressFrame(source, width, height, ratio = null) {
  if (!width || !height) throw Error('La cámara todavía no está lista. Esperá un momento y volvé a intentar.');
  const crop = ratio ? cameraCrop(width,height,ratio) : {x:0,y:0,width,height};
  const canvas = document.createElement('canvas');
  try {
    let max = 1200;
    for (let attempt = 0; attempt < 8; attempt++, max = Math.round(max * .78)) {
      const scale = Math.min(1,max / Math.max(crop.width,crop.height));
      canvas.width = Math.max(1,Math.round(crop.width*scale));
      canvas.height = Math.max(1,Math.round(crop.height*scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) throw Error('No hay memoria disponible para procesar la foto. Cerrá otras pestañas y reintentá.');
      ctx.fillStyle = '#fff'; ctx.fillRect(0,0,canvas.width,canvas.height);
      ctx.drawImage(source,crop.x,crop.y,crop.width,crop.height,0,0,canvas.width,canvas.height);
      for (const quality of [.82,.68,.54]) {
        const blob = await new Promise(resolve => canvas.toBlob(resolve,'image/jpeg',quality));
        if (blob?.type === 'image/jpeg' && blob.size <= PHOTO_LIMIT) return blob;
      }
    }
    throw Error('No se pudo reducir la foto. Probá con otra imagen.');
  } finally {
    // Release the backing buffer immediately, including failed conversions.
    canvas.width = 0; canvas.height = 0;
  }
}
export async function compressPhoto(file) {
  if (file.size > 40 * 1024 * 1024) throw Error('La foto original supera los 40 MB. Elegí una más pequeña.');
  const url = URL.createObjectURL(file);
  const image = new Image();
  try {
    image.src = url;
    try { await image.decode(); } catch { throw Error('No se pudo abrir la foto. Probá con JPEG, PNG o WebP.'); }
    return await compressFrame(image,image.naturalWidth,image.naturalHeight);
  } finally { image.src = ''; URL.revokeObjectURL(url); }
}
