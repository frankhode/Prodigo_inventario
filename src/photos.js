export const PHOTO_LIMIT = 150 * 1024;
// Both camera frames and files use a small canvas; never create a full-size camera canvas.
export async function compressFrame(source, width, height) {
  if (!width || !height) throw Error('La cámara todavía no está lista. Esperá un momento y volvé a intentar.');
  const canvas = document.createElement('canvas');
  try {
    let max = 1200;
    for (let attempt = 0; attempt < 8; attempt++, max = Math.round(max * .78)) {
      const scale = Math.min(1,max / Math.max(width,height));
      canvas.width = Math.max(1,Math.round(width*scale));
      canvas.height = Math.max(1,Math.round(height*scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) throw Error('No hay memoria disponible para procesar la foto. Cerrá otras pestañas y reintentá.');
      ctx.fillStyle = '#fff'; ctx.fillRect(0,0,canvas.width,canvas.height);
      ctx.drawImage(source,0,0,canvas.width,canvas.height);
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
