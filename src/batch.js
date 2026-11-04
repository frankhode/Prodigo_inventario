const filenameOrder = new Intl.Collator('es', { numeric:true, sensitivity:'base' });
const imageExtension = /\.(?:avif|bmp|gif|heic|heif|jpe?g|png|tiff?|webp)$/i;

export function orderedBatchImages(files) {
  return Array.from(files).filter(file =>
    // A folder picker can also return subfolders. Keep each folder's sequence separate.
    file.webkitRelativePath.split('/').length <= 2 &&
    (file.type.startsWith('image/') || imageExtension.test(file.name))
  ).sort((a,b) => filenameOrder.compare(a.name,b.name) || (a.name < b.name ? -1 : Number(a.name > b.name)));
}
