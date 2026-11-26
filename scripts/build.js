import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
await rm('dist',{recursive:true,force:true});
await mkdir('dist',{recursive:true});
await cp('public','dist',{recursive:true});
await build({entryPoints:['src/app.js'],bundle:true,outfile:'dist/app.js',format:'esm',target:['safari14.1','ios14.5','chrome89','firefox89'],minify:true});
// Las versiones del HTML y sus recursos deben coincidir también con caché.
let html = await readFile('dist/index.html','utf8');
for (const file of ['styles.css','config.js','app.js']) {
  const hash = createHash('sha256').update(await readFile(`dist/${file}`)).digest('hex').slice(0,12);
  html = html.replace(`"./${file}"`,`"./${file}?v=${hash}"`);
}
await writeFile('dist/index.html',html);
console.log('App estática generada en dist/.');
