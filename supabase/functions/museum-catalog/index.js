// Consulta pública de solo lectura. Los permisos del inventario y su bucket siguen privados.
const fields = 'code,category,brand,model,manufacture_date,type';
const pageSize = 250;
const isCode = value => /^P[0-9]{6}$/.test(value);

export async function handleCatalog(request, {
  env = name => globalThis.Deno?.env.get(name),
  fetchImpl = fetch,
} = {}) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  const json = (value, status = 200) => Response.json(value, { status, headers });
  if (request.method !== 'GET') return json({ error: 'Método no permitido.' }, 405);
  const params = new URL(request.url).searchParams;
  const photo = params.get('foto');
  const after = params.get('desde');
  if ((photo !== null && !isCode(photo)) || (after !== null && !isCode(after))) {
    return json({ error: 'Código inválido.' }, 400);
  }

  try {
    const root = env('SUPABASE_URL');
    const legacy = env('SUPABASE_SERVICE_ROLE_KEY');
    const secret = legacy || JSON.parse(env('SUPABASE_SECRET_KEYS') || '{}').default;
    if (!root || !secret) throw Error('Configuración incompleta');
    const auth = legacy ? { apikey: legacy, Authorization: 'Bearer ' + legacy } : { apikey: secret };
    const query = new URL('rest/v1/inventory_items', root);
    query.searchParams.set('destination', 'eq.museo');

    if (photo) {
      query.searchParams.set('select', 'photo_path');
      query.searchParams.set('code', 'eq.' + photo);
      const record = await fetchImpl(query, { headers: auth });
      if (!record.ok) throw Error('Error de consulta');
      const [row] = await record.json();
      if (!row) return json({ error: 'Foto no disponible.' }, 404);
      const path = row.photo_path.split('/').map(encodeURIComponent).join('/');
      const file = await fetchImpl(new URL('storage/v1/object/authenticated/inventory-photos/' + path, root), { headers: auth });
      if (!file.ok || !file.body) return json({ error: 'Foto no disponible.' }, file.status < 500 ? 404 : 503);
      return new Response(file.body, { headers: { ...headers, 'Content-Type': 'image/jpeg' } });
    }

    query.searchParams.set('select', fields + ',original_number');
    query.searchParams.set('order', 'code.asc');
    query.searchParams.set('limit', String(pageSize));
    if (after) query.searchParams.set('code', 'gt.' + after);
    let result = await fetchImpl(query, { headers: auth });
    // Los inventarios que todavía no aplicaron la migración de numeración también se pueden consultar.
    if (!result.ok && (await result.json()).code === '42703') {
      query.searchParams.set('select', fields);
      result = await fetchImpl(query, { headers: auth });
    }
    if (!result.ok) throw Error('Error de consulta');
    const items = await result.json();
    return json({ items, next: items.length ? items.at(-1).code : null });
  } catch {
    return json({ error: 'Catálogo no disponible.' }, 503);
  }
}

if (globalThis.Deno) Deno.serve(request => handleCatalog(request));
