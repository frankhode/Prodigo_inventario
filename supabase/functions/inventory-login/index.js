// Acceso por nombre de usuario. No registra contraseñas, correos ni tokens en logs.
// Este archivo se ejecuta exclusivamente como Edge Function de Supabase.
// También se puede pegar, completo, en el index.ts del editor del Dashboard.
const INVALID = {code:'invalid_credentials',message:'Usuario o contraseña incorrectos.'};
const UNAVAILABLE = {code:'login_unavailable',message:'No se pudo completar el acceso por usuario. Podés intentar con tu correo.'};
const DUMMY_ID = '00000000-0000-4000-8000-000000000000';
const DUMMY_EMAIL = 'unknown-login@inventory.invalid';

function keySet(env,plural,legacy) {
  const raw = env(plural);
  if (raw) {
    const keys = JSON.parse(raw);
    return [keys.default,...Object.values(keys)].filter(value => typeof value === 'string' && value);
  }
  const value = env(legacy); return value ? [value] : [];
}
async function readJson(request) {
  const reader = request.body?.getReader(); if (!reader) throw Error();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const {done,value} = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 4096) { await reader.cancel(); throw Error(); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export async function handleLogin(request,{env = name => globalThis.Deno?.env.get(name),fetchImpl = fetch} = {}) {
  const origin = request.headers.get('Origin');
  const allowed = (env('INVENTORY_ALLOWED_ORIGINS') || 'https://frankhode.github.io,http://localhost:3000,http://127.0.0.1:3000').split(',').map(value => value.trim());
  const headers = {'Content-Type':'application/json','Cache-Control':'no-store','Vary':'Origin',
    'Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'apikey, content-type, authorization, x-client-info'};
  if (origin && allowed.includes(origin)) headers['Access-Control-Allow-Origin'] = origin;
  const respond = (status,body,extra = {}) => new Response(JSON.stringify(body),{status,headers:{...headers,...extra}});
  if (origin && !allowed.includes(origin)) return respond(403,{message:'Origen no permitido.'});
  if (request.method === 'OPTIONS') return new Response(null,{status:204,headers});
  if (request.method !== 'POST') return respond(405,{message:'Método no permitido.'},{Allow:'POST, OPTIONS'});
  try {
    const root = env('SUPABASE_URL')?.replace(/\/$/,'');
    const publicKeys = keySet(env,'SUPABASE_PUBLISHABLE_KEYS','SUPABASE_ANON_KEY');
    const secret = keySet(env,'SUPABASE_SECRET_KEYS','SUPABASE_SERVICE_ROLE_KEY')[0];
    if (!root || !secret || !publicKeys.length) return respond(503,UNAVAILABLE);
    const publicKey = request.headers.get('apikey');
    if (!publicKeys.includes(publicKey)) return respond(403,{message:'Aplicación no autorizada.'});
    if (!request.headers.get('content-type')?.includes('application/json')) return respond(415,{message:'Se requiere JSON.'});
    let body;
    try { body = await readJson(request); } catch { return respond(400,{message:'Solicitud inválida.'}); }
    const username = typeof body?.username === 'string' ? body.username.trim().toLowerCase() : '';
    const password = body?.password;
    if (!/^[a-z][a-z0-9_]{2,31}$/.test(username) || typeof password !== 'string' || !password.length || password.length > 200) return respond(401,INVALID);

    const adminHeaders = {apikey:secret};
    // Los nombres se resuelven en una tabla privada. Ningún correo se devuelve al visitante.
    const query = new URLSearchParams({select:'user_id',username_key:`eq.${username}`,limit:'1'});
    const memberResponse = await fetchImpl(`${root}/rest/v1/inventory_members?${query}`,{headers:adminHeaders,signal:AbortSignal.timeout(10000)});
    if (!memberResponse.ok) return respond(503,UNAVAILABLE);
    const members = await memberResponse.json();
    const member = Array.isArray(members) ? members[0] : null;
    // También hacer la consulta Auth y el intento de contraseña para un nombre desconocido.
    const userResponse = await fetchImpl(`${root}/auth/v1/admin/users/${member?.user_id || DUMMY_ID}`,{headers:adminHeaders,signal:AbortSignal.timeout(10000)});
    if (!userResponse.ok && userResponse.status !== 404) return respond(503,UNAVAILABLE);
    const userPayload = userResponse.ok ? await userResponse.json() : null;
    const user = userPayload?.user ?? userPayload;
    const email = member && typeof user?.email === 'string' ? user.email : DUMMY_EMAIL;
    const loginResponse = await fetchImpl(`${root}/auth/v1/token?grant_type=password`,{
      method:'POST',headers:{apikey:publicKey,'Content-Type':'application/json'},
      body:JSON.stringify({email,password}),signal:AbortSignal.timeout(10000)
    });
    if (loginResponse.status === 429) return respond(429,{code:'too_many_attempts',message:'Hubo muchos intentos. Esperá un minuto y volvé a intentar.'},{'Retry-After':'60'});
    if (loginResponse.status >= 500) return respond(503,UNAVAILABLE);
    if (!loginResponse.ok || !member || !user?.email) return respond(401,INVALID);
    const session = await loginResponse.json();
    if (!session.access_token || !session.refresh_token || session.user?.id !== member.user_id) return respond(401,INVALID);
    return respond(200,{access_token:session.access_token,refresh_token:session.refresh_token});
  } catch { return respond(503,UNAVAILABLE); }
}

if (typeof Deno !== 'undefined') Deno.serve(request => handleLogin(request));
