import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleLogin } from '../supabase/functions/inventory-login/index.js';

const root = 'https://fixture.supabase.co', publicKey = 'sb_publishable_fixture', secretKey = 'sb_secret_fixture';
const uid = '11111111-1111-4111-8111-111111111111', email = 'private@example.test';
const env = name => ({SUPABASE_URL:root,SUPABASE_PUBLISHABLE_KEYS:JSON.stringify({default:publicKey}),SUPABASE_SECRET_KEYS:JSON.stringify({default:secretKey})})[name];
const request = (body = {username:'franProdigo',password:'Contraseña de prueba'},options = {}) => new Request(root+'/functions/v1/inventory-login',{
  method:options.method || 'POST',headers:{Origin:'https://frankhode.github.io',apikey:publicKey,'content-type':'application/json',...options.headers},
  ...(options.method === 'OPTIONS' || options.method === 'GET' ? {} : {body:typeof body === 'string' ? body : JSON.stringify(body)})
});
const json = (data,status = 200) => new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
function backend({unknown = false,badPassword = false,rateLimited = false,failedLookup = false,wrappedUser = false} = {}) {
  const calls = [];
  return {calls,fetchImpl:async (url,options) => {
    calls.push({url,options});
    if (url.includes('/rest/v1/')) return failedLookup ? json({message:'internal details'},500) : json(unknown ? [] : [{user_id:uid}]);
    if (url.includes('/admin/users/')) return unknown ? json({},404) : json(wrappedUser ? {user:{id:uid,email}} : {id:uid,email});
    if (rateLimited) return json({},429);
    return badPassword || unknown ? json({message:'Auth failure details'},400) : json({access_token:'access-fixture',refresh_token:'refresh-fixture',user:{id:uid,email}});
  }};
}
test('Resuelve el usuario en el servidor y devuelve sesión sin exponer el correo ni la clave administrativa',async () => {
  const mock = backend();
  const response = await handleLogin(request({username:'  FRANprodigo  ',password:'Contraseña de prueba'}),{env,fetchImpl:mock.fetchImpl});
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{access_token:'access-fixture',refresh_token:'refresh-fixture'});
  assert.match(mock.calls[0].url,/username_key=eq\.franprodigo/);
  assert.equal(mock.calls[0].options.headers.apikey,secretKey);
  assert.equal(mock.calls[1].options.headers.apikey,secretKey);
  assert.equal(mock.calls[2].options.headers.apikey,publicKey);
  assert.deepEqual(JSON.parse(mock.calls[2].options.body),{email,password:'Contraseña de prueba'});
  assert.equal(response.headers.get('cache-control'),'no-store');
  assert.equal(response.headers.get('access-control-allow-origin'),'https://frankhode.github.io');
});
test('Acepta la respuesta Auth con el usuario dentro del objeto user',async () => {
  const mock = backend({wrappedUser:true});
  assert.equal((await handleLogin(request(),{env,fetchImpl:mock.fetchImpl})).status,200);
});
test('Usuario desconocido y contraseña incorrecta dan el mismo error y tres operaciones remotas',async () => {
  const bodies = [];
  for (const options of [{unknown:true},{badPassword:true}]) {
    const mock = backend(options); const response = await handleLogin(request(),{env,fetchImpl:mock.fetchImpl});
    assert.equal(response.status,401); assert.equal(mock.calls.length,3); bodies.push(await response.text());
  }
  assert.equal(bodies[0],bodies[1]); assert.ok(!bodies[0].includes(email)); assert.ok(!bodies[0].includes(secretKey));
});
test('No acepta nombres manipulados, contraseñas vacías ni cuerpos enormes',async () => {
  let called = false; const fetchImpl = async () => {called = true; throw Error();};
  for (const body of [{username:'fran,or(user_id)',password:'x'},{username:'franProdigo',password:''},{username:'franProdigo',password:'x'.repeat(300)}]) {
    assert.equal((await handleLogin(request(body),{env,fetchImpl})).status,401);
  }
  assert.equal((await handleLogin(request('x'.repeat(5000)),{env,fetchImpl})).status,400);
  assert.equal(called,false);
});
test('CORS, método y clave de aplicación se controlan antes de consultar cuentas',async () => {
  const fetchImpl = async () => {throw Error('No debe consultar');};
  assert.equal((await handleLogin(request(null,{method:'OPTIONS'}),{env,fetchImpl})).status,204);
  assert.equal((await handleLogin(request(null,{method:'GET'}),{env,fetchImpl})).status,405);
  assert.equal((await handleLogin(request(undefined,{headers:{Origin:'https://otro.example'}}),{env,fetchImpl})).status,403);
  assert.equal((await handleLogin(request(undefined,{headers:{apikey:'otra'}}),{env,fetchImpl})).status,403);
});
test('Conserva el límite de intentos de Auth y no revela errores internos',async () => {
  let mock = backend({rateLimited:true});
  let response = await handleLogin(request(),{env,fetchImpl:mock.fetchImpl});
  assert.equal(response.status,429); assert.equal(response.headers.get('retry-after'),'60');
  mock = backend({failedLookup:true}); response = await handleLogin(request(),{env,fetchImpl:mock.fetchImpl});
  assert.equal(response.status,503); assert.ok(!(await response.text()).includes('internal details'));
});
