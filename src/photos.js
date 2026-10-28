export const PHOTO_LIMIT = 150 * 1024;
export async function compressPhoto(file) {
  if (file.size > 40 * 1024 * 1024) throw Error('La foto original supera los 40 MB. Elegí una más pequeña.');
  const url = URL.createObjectURL(file);
  try {
    const image = new Image(); image.src = url;
    try { await image.decode(); } catch { throw Error('No se pudo abrir la foto. Probá con JPEG, PNG o WebP.'); }
    const canvas = document.createElement('canvas');
    let max = 1200;
    // El límite es de bytes, no solo de dimensiones: también se comprimen fotos complejas.
    for (let attempt = 0; attempt < 8; attempt++, max = Math.round(max * .78)) {
      const scale = Math.min(1,max / Math.max(image.naturalWidth,image.naturalHeight));
      canvas.width = Math.max(1,Math.round(image.naturalWidth*scale));
      canvas.height = Math.max(1,Math.round(image.naturalHeight*scale));
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0,0,canvas.width,canvas.height);
      ctx.drawImage(image,0,0,canvas.width,canvas.height);
      for (const quality of [.82,.68,.54]) {
        const blob = await new Promise(resolve => canvas.toBlob(resolve,'image/jpeg',quality));
        if (blob && blob.size <= PHOTO_LIMIT) return blob;
      }
    }
    throw Error('No se pudo reducir la foto. Probá con otra imagen.');
  } finally { URL.revokeObjectURL(url); }
}
