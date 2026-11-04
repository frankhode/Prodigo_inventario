const minScale = .2;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function validCrop(crop) {
  if (!Array.isArray(crop) || crop.length !== 4 || !crop.every(Number.isFinite)) return false;
  const [x,y,width,height] = crop;
  return x >= 0 && y >= 0 && width > 0 && height > 0
    && width <= 1 && height <= 1 && x + width <= 1.000001 && y + height <= 1.000001;
}

export function squareCrop(imageWidth, imageHeight, centerX, centerY, scale) {
  const side = Math.min(imageWidth,imageHeight) * clamp(scale,minScale,1);
  const width = side / imageWidth;
  const height = side / imageHeight;
  return [clamp(centerX-width/2,0,1-width),clamp(centerY-height/2,0,1-height),width,height];
}

export function cropThumbnail(image, crop) {
  if (!validCrop(crop)) return image;
  const [x,y,width,height] = crop;
  const frame = document.createElement('span');
  frame.className = 'catalog-crop';
  Object.assign(image.style,{
    left:`${-100*x/width}%`, top:`${-100*y/height}%`,
    width:`${100/width}%`, height:`${100/height}%`,
  });
  frame.append(image);
  return frame;
}

export function createCropEditor(dialog, onApply) {
  const image = dialog.querySelector('img');
  const surface = dialog.querySelector('.crop-surface');
  const selection = dialog.querySelector('.crop-selection');
  const size = dialog.querySelector('input');
  const apply = dialog.querySelector('[data-crop-apply]');
  const clear = dialog.querySelector('[data-crop-clear]');
  const message = dialog.querySelector('[role=status]');
  let draft = null;
  let drag = null;
  let opening = 0;

  function update(centerX, centerY) {
    draft = squareCrop(image.naturalWidth,image.naturalHeight,centerX,centerY,Number(size.value)/100);
    const [x,y,w,h] = draft;
    Object.assign(selection.style,{left:`${100*x}%`,top:`${100*y}%`,width:`${100*w}%`,height:`${100*h}%`});
  }
  function center() {
    const [x,y,w,h] = draft;
    return [x+w/2,y+h/2];
  }
  function point(event) {
    const bounds = surface.getBoundingClientRect();
    return [(event.clientX-bounds.left)/bounds.width,(event.clientY-bounds.top)/bounds.height];
  }
  size.addEventListener('input',() => { if (draft) update(...center()); });
  surface.addEventListener('pointerdown',event => {
    if (!draft || drag || event.button !== 0) return;
    const [x,y] = point(event);
    const [left,top,w,h] = draft;
    const inside = x >= left && x <= left+w && y >= top && y <= top+h;
    const [cx,cy] = inside ? center() : [x,y];
    drag = {id:event.pointerId,x:cx-x,y:cy-y};
    surface.setPointerCapture(event.pointerId);
    update(cx,cy);
  });
  surface.addEventListener('pointermove',event => {
    if (drag?.id !== event.pointerId) return;
    const [x,y] = point(event);
    update(x+drag.x,y+drag.y);
  });
  surface.addEventListener('lostpointercapture',event => {
    if (drag?.id === event.pointerId) drag = null;
  });
  surface.addEventListener('keydown',event => {
    if (!draft) return;
    const movement = {ArrowLeft:[-.02,0],ArrowRight:[.02,0],ArrowUp:[0,-.02],ArrowDown:[0,.02]}[event.key];
    if (!movement) return;
    event.preventDefault();
    const [x,y] = center();
    update(x+movement[0],y+movement[1]);
  });
  function finish(crop) {
    onApply(crop);
    dialog.close();
  }
  apply.addEventListener('click',() => { if (draft) finish(draft); });
  clear.addEventListener('click',() => finish(null));
  dialog.querySelector('[data-crop-cancel]').addEventListener('click',() => dialog.close());
  dialog.addEventListener('close',() => {
    opening++;
    draft = null;
    drag = null;
    image.removeAttribute('src');
  });

  return async function open(url, crop) {
    const attempt = ++opening;
    draft = null;
    surface.hidden = true;
    size.disabled = apply.disabled = true;
    clear.hidden = !validCrop(crop);
    message.textContent = 'Cargando foto…';
    image.src = url;
    dialog.showModal();
    try {
      await image.decode();
      if (!dialog.open || attempt !== opening) return;
      const [x,y,w,h] = validCrop(crop) ? crop : [0,0,1,1];
      const scale = Math.min(w*image.naturalWidth,h*image.naturalHeight)
        / Math.min(image.naturalWidth,image.naturalHeight);
      size.value = String(clamp(scale,minScale,1)*100);
      update(x+w/2,y+h/2);
      surface.hidden = false;
      size.disabled = apply.disabled = false;
      message.textContent = 'Mové el recuadro sobre la foto y ajustá su tamaño.';
    } catch {
      if (dialog.open && attempt === opening) message.textContent = 'No se pudo abrir la foto para recortarla.';
    }
  };
}
