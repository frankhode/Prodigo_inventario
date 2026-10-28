import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync, statSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));
const photoDir = path.join(dataDir, 'photos');
mkdirSync(photoDir, { recursive: true, mode: 0o700 });
const db = new DatabaseSync(path.join(dataDir, 'inventory.sqlite'));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, expires INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT, brand TEXT NOT NULL, model TEXT NOT NULL,
    date TEXT NOT NULL, type TEXT NOT NULL, destination TEXT NOT NULL,
    notes TEXT NOT NULL, photos TEXT NOT NULL, created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1
  );`);
const destinations = ['museo', 'tienda', 'otros'];
const maxBody = 30 * 1024 * 1024;
const setupToken = randomBytes(18).toString('hex');
const attempts = new Map();
const q = (sql) => db.prepare(sql);
const configured = () => !!q("SELECT value FROM settings WHERE key='password'").get();
const digest = (value) => createHash('sha256').update(value).digest('hex');
const code = (id) => `PRO-${String(id).padStart(5, '0')}`;
function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
function fail(status, message) { throw Object.assign(new Error(message), { status }); }
function text(value, name, max, required = false) {
  if (typeof value !== 'string') fail(400, `Revisá el campo ${name}.`);
  const clean = value.trim();
  if ((required && !clean) || clean.length > max) fail(400, `Revisá el campo ${name} (máximo ${max} caracteres).`);
  return clean;
}
function fields(body) {
  const item = {
    brand: text(body.brand, 'marca', 120, true), model: text(body.model ?? '', 'modelo', 120),
    date: text(body.date ?? '', 'fecha', 80), type: text(body.type ?? '', 'tipo', 120),
    destination: text(body.destination, 'destino', 20, true), notes: text(body.notes ?? '', 'notas', 4000)
  };
  if (!destinations.includes(item.destination)) fail(400, 'Elegí Museo, Tienda u Otros.');
  return item;
}
function photoInput(value) {
  if (typeof value !== 'string') fail(400, 'La fotografía no es válida.');
  const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) fail(400, 'Usá fotografías JPEG, PNG o WebP.');
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > 4 * 1024 * 1024 || buffer.length < 12) fail(400, 'Cada foto debe pesar menos de 4 MB.');
  const type = match[1];
  const valid = type === 'jpeg' ? buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255
    : type === 'png' ? buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
      : buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
  if (!valid) fail(400, 'El contenido de la foto no coincide con su formato.');
  return { buffer, ext: type === 'jpeg' ? 'jpg' : type };
}
function serialize(row) {
  return { ...row, code: code(row.id), photos: JSON.parse(row.photos).map(id => ({ id, url: `/photos/${id}` })) };
}
async function bodyJson(req) {
  let size = 0; const parts = [];
  for await (const part of req) {
    size += part.length;
    if (size > maxBody) fail(413, 'La carga es demasiado grande. Usá hasta 5 fotos de menos de 4 MB.');
    parts.push(part);
  }
  try { const body = JSON.parse(Buffer.concat(parts).toString('utf8')); if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error(); return body; }
  catch { fail(400, 'No se pudo leer el formulario.'); }
}
function session(req) {
  const token = /(?:^|;\s*)prodigo_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
  return token && q('SELECT token FROM sessions WHERE token=? AND expires>?').get(digest(token), Date.now());
}
function newSession(res) {
  const token = randomBytes(32).toString('hex');
  q('DELETE FROM sessions WHERE expires<?').run(Date.now());
  q('INSERT INTO sessions VALUES (?,?)').run(digest(token), Date.now() + 7 * 86400000);
  res.setHeader('Set-Cookie', `prodigo_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${process.env.SECURE_COOKIE === 'true' ? '; Secure' : ''}`);
}
function rateLimit(req) {
  const key = req.socket.remoteAddress; const now = Date.now();
  for (const [ip, entry] of attempts) if (entry.until < now) attempts.delete(ip);
  const entry = attempts.get(key) || { count: 0, until: now + 15 * 60000 };
  entry.count++; attempts.set(key, entry);
  if (entry.count > 20) fail(429, 'Demasiados intentos. Volvé a intentar en 15 minutos.');
}
function saveItem(body, current) {
  const values = fields(body);
  if (!Array.isArray(body.photos) || body.photos.length > 5) fail(400, 'Podés guardar hasta 5 fotos por ítem.');
  const previous = current ? JSON.parse(current.photos) : [];
  const prepared = body.photos.map(photo => {
    if (typeof photo?.id === 'string' && previous.includes(photo.id)) return { id: photo.id };
    if (!photo || photo.id) fail(400, 'Una foto no pertenece a este ítem.');
    return photoInput(photo.data);
  });
  const files = []; const photos = [];
  try {
    for (const photo of prepared) {
      if (photo.id) { photos.push(photo.id); continue; }
      const id = `${randomBytes(16).toString('hex')}.${photo.ext}`;
      writeFileSync(path.join(photoDir, id), photo.buffer, { flag: 'wx', mode: 0o600 });
      files.push(id); photos.push(id);
    }
    const now = new Date().toISOString();
    let id;
    if (current) {
      if (body.version !== current.version) fail(409, 'Este ítem cambió en otro dispositivo. Cerrá y volvé a abrir la ficha antes de editar.');
      q('UPDATE items SET brand=?,model=?,date=?,type=?,destination=?,notes=?,photos=?,updated_at=?,version=version+1 WHERE id=?')
        .run(...Object.values(values), JSON.stringify(photos), now, current.id);
      id = current.id;
    } else {
      id = Number(q('INSERT INTO items (brand,model,date,type,destination,notes,photos,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(...Object.values(values), JSON.stringify(photos), now, now).lastInsertRowid);
    }
    for (const old of previous) if (!photos.includes(old)) { try { unlinkSync(path.join(photoDir, old)); } catch {} }
    return serialize(q('SELECT * FROM items WHERE id=?').get(id));
  } catch (error) {
    for (const file of files) { try { unlinkSync(path.join(photoDir, file)); } catch {} }
    throw error;
  }
}
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.webmanifest': 'application/manifest+json' };
function serve(res, filename, privateFile = false) {
  if (!existsSync(filename)) fail(404, 'Archivo no encontrado.');
  res.writeHead(200, { 'Content-Type': mime[path.extname(filename)] || 'application/octet-stream', 'Content-Length': statSync(filename).size, 'Cache-Control': privateFile ? 'private, no-store' : 'no-cache' });
  const stream = createReadStream(filename); stream.on('error', () => res.destroy()); stream.pipe(res);
}
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  try {
    const url = new URL(req.url, 'http://localhost'); const route = url.pathname;
    const method = req.method;
    if (!['GET', 'HEAD'].includes(method)) {
      if (req.headers['x-requested-with'] !== 'prodigo') fail(403, 'Solicitud no permitida.');
      const expected = process.env.PUBLIC_ORIGIN || `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`;
      if (req.headers.origin && req.headers.origin !== expected) fail(403, 'Origen no permitido.');
      if (method !== 'DELETE' && !req.headers['content-type']?.startsWith('application/json')) fail(415, 'Usá un formulario JSON.');
    }
    if (route === '/api/session' && method === 'GET') return json(res, 200, { configured: configured(), authenticated: !!session(req) });
    if (route === '/api/setup' && method === 'POST') {
      if (configured()) fail(409, 'La aplicación ya está configurada.');
      rateLimit(req); const body = await bodyJson(req);
      if (typeof body.token !== 'string' || digest(body.token) !== digest(setupToken)) fail(403, 'El código de instalación no es correcto. Consultá la consola del servidor.');
      const password = body.password;
      if (typeof password !== 'string' || password.length < 10 || password.length > 200 || !password.trim()) fail(400, 'Usá una contraseña de entre 10 y 200 caracteres.');
      if (configured()) fail(409, 'La aplicación ya está configurada.');
      const salt = randomBytes(16).toString('hex');
      q("INSERT INTO settings VALUES ('password',?)").run(`${salt}:${scryptSync(password, salt, 64).toString('hex')}`);
      newSession(res); return json(res, 201, { ok: true });
    }
    if (route === '/api/login' && method === 'POST') {
      rateLimit(req); const body = await bodyJson(req);
      const stored = q("SELECT value FROM settings WHERE key='password'").get()?.value;
      if (!stored) fail(409, 'Primero configurá la aplicación.');
      const [salt, hash] = stored.split(':');
      if (typeof body.password !== 'string' || body.password.length > 200 || !timingSafeEqual(scryptSync(body.password, salt, 64), Buffer.from(hash, 'hex'))) fail(401, 'La contraseña no es correcta.');
      attempts.delete(req.socket.remoteAddress); newSession(res); return json(res, 200, { ok: true });
    }
    if (route.startsWith('/api/') || route.startsWith('/photos/')) {
      if (!session(req)) fail(401, 'Ingresá para continuar.');
      if (route === '/api/logout' && method === 'POST') {
        const token = /prodigo_session=([a-f0-9]{64})/.exec(req.headers.cookie || '')?.[1];
        if (token) q('DELETE FROM sessions WHERE token=?').run(digest(token));
        res.setHeader('Set-Cookie', 'prodigo_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); return json(res, 200, { ok: true });
      }
      if (route === '/api/items' && method === 'GET') return json(res, 200, { items: q('SELECT * FROM items ORDER BY id DESC').all().map(serialize) });
      if (route === '/api/items' && method === 'POST') return json(res, 201, saveItem(await bodyJson(req)));
      const match = /^\/api\/items\/([1-9]\d*)$/.exec(route);
      if (match) {
        const current = q('SELECT * FROM items WHERE id=?').get(Number(match[1]));
        if (!current) fail(404, 'El ítem ya no existe.');
        if (method === 'GET') return json(res, 200, serialize(current));
        if (method === 'PUT') return json(res, 200, saveItem(await bodyJson(req), current));
        if (method === 'DELETE') {
          if (url.searchParams.get('version') !== String(current.version)) fail(409, 'El ítem cambió. Volvé a abrir la ficha antes de eliminar.');
          q('DELETE FROM items WHERE id=?').run(current.id);
          for (const file of JSON.parse(current.photos)) { try { unlinkSync(path.join(photoDir, file)); } catch {} }
          return json(res, 200, { ok: true });
        }
      }
      if (route === '/api/export.csv' && method === 'GET') {
        const cell = value => `"${String(value ?? '').replace(/^[=+@\-\t\r]/, "'$&").replaceAll('"', '""')}"`;
        const rows = [['Código','Marca','Modelo','Fecha','Tipo','Destino','Notas','Fotos','Alta','Modificación'], ...q('SELECT * FROM items ORDER BY id').all().map(i => [code(i.id),i.brand,i.model,i.date,i.type,i.destination,i.notes,JSON.parse(i.photos).length,i.created_at,i.updated_at])];
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="prodigo-inventario.csv"', 'Cache-Control': 'no-store' });
        return res.end('\uFEFF' + rows.map(row => row.map(cell).join(';')).join('\r\n'));
      }
      if (route.startsWith('/photos/') && method === 'GET') {
        const name = route.slice(8); if (!/^[a-f0-9]{32}\.(jpg|png|webp)$/.test(name)) fail(404, 'Fotografía no encontrada.');
        return serve(res, path.join(photoDir, name), true);
      }
      fail(404, 'Recurso no encontrado.');
    }
    const files = { '/': 'index.html', '/app.js': 'app.js', '/styles.css': 'styles.css', '/icon.svg': 'icon.svg', '/manifest.webmanifest': 'manifest.webmanifest' };
    if ((method === 'GET' || method === 'HEAD') && files[route]) return serve(res, path.join(root, 'public', files[route]));
    fail(404, 'Página no encontrada.');
  } catch (error) {
    if (!error.status) console.error(error);
    if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : 'No se pudo completar la operación. Volvé a intentar.' });
    else res.destroy();
  }
});
server.requestTimeout = 60000;
const cliOption = name => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
server.listen(Number(cliOption('--port') ?? process.env.PORT ?? 3000), cliOption('--host') || process.env.HOST || '0.0.0.0', () => {
  console.log(`Pródigo Inventario: puerto ${server.address().port}`);
  if (!configured()) console.log(`Código de instalación (usar una sola vez): ${setupToken}`);
});
for (const signal of ['SIGTERM','SIGINT']) process.on(signal, () => server.close(() => { db.close(); process.exit(0); }));
