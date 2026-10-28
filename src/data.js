import { createClient } from '@supabase/supabase-js';

export function connect(config) {
  if (!config?.supabaseUrl || !config?.publishableKey) return null;
  // Solamente claves públicas; nunca una clave secreta o service_role.
  if (!/^sb_publishable_/.test(config.publishableKey)) {
    try {
      const payload = JSON.parse(atob(config.publishableKey.split('.')[1].replaceAll('-','+').replaceAll('_','/')));
      if (payload.role !== 'anon') throw Error();
    } catch { throw Error('La configuración necesita la clave pública de Supabase.'); }
  }
  const client = createClient(config.supabaseUrl,config.publishableKey);
  const photoUrls = new Map();
  const check = result => { if (result.error) throw result.error; return result.data; };
  async function all(table) {
    const rows = [];
    for (let offset = 0;; offset += 500) {
      let query = client.from(table).select('*');
      query = table === 'inventory_items' ? query.order('number') : query.order('kind').order('category_key').order('parent_key').order('name_key');
      const result = check(await query.range(offset,offset+499));
      rows.push(...result); if (result.length < 500) return rows;
    }
  }
  return {
    client,
    async session() { return check(await client.auth.getSession()).session; },
    async register({username,email,password,invitationCode}) {
      return check(await client.auth.signUp({email:email.trim(),password,
        options:{data:{username,inventory_invite:invitationCode.trim()}}}));
    },
    async login(identity,password) {
      const value = identity.trim();
      if (value.includes('@')) return check(await client.auth.signInWithPassword({email:value,password}));
      const response = await fetch(`${config.supabaseUrl}/functions/v1/${config.loginFunction || 'inventory-login'}`,{
        method:'POST',headers:{apikey:config.publishableKey,'Content-Type':'application/json'},
        body:JSON.stringify({username:value,password})
      });
      const result = await response.json().catch(() => ({}));
      if (response.status === 404) throw Error('El acceso por usuario todavía no está activado. Podés ingresar con tu correo.');
      if (!response.ok) {
        const error = Error(result.message || 'No se pudo completar el acceso por usuario.');
        error.code = result.code; throw error;
      }
      return check(await client.auth.setSession({access_token:result.access_token,refresh_token:result.refresh_token}));
    },
    async logout() { check(await client.auth.signOut({scope:'local'})); photoUrls.clear(); },
    async load() {
      const user = check(await client.auth.getUser()).user;
      const member = check(await client.from('inventory_members').select('display_name').eq('user_id',user.id).maybeSingle());
      if (!member) throw Error('Tu cuenta todavía no tiene acceso al inventario. Pedile al administrador que la habilite.');
      const [items,terms] = await Promise.all([all('inventory_items'),all('inventory_terms')]);
      return {user,member,items,terms};
    },
    async photoUrl(path) {
      const cached = photoUrls.get(path);
      if (cached?.expires > Date.now()) return cached.url;
      const result = check(await client.storage.from('inventory-photos').createSignedUrl(path,3600));
      photoUrls.set(path,{url:result.signedUrl,expires:Date.now()+45*60*1000}); return result.signedUrl;
    },
    async save({id,revision,values,photo,photoPath,userId}) {
      let path = photoPath;
      if (photo) {
        const digest = await crypto.subtle.digest('SHA-256',await photo.arrayBuffer());
        const hash = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2,'0')).join('');
        path = `${userId}/${id}/${hash}.jpg`;
        const uploaded = await client.storage.from('inventory-photos').upload(path,photo,{contentType:'image/jpeg',upsert:false});
        if (uploaded.error && !['Duplicate','409'].includes(String(uploaded.error.error ?? uploaded.error.statusCode)) && !/already exists/i.test(uploaded.error.message)) throw uploaded.error;
      }
      const result = check(await client.rpc('save_inventory_item',{p_id:id,p_revision:revision,p_values:values,p_photo_path:path}));
      const saved = Array.isArray(result) ? result[0] : result;
      if (!saved?.id || !saved.code) throw Error('No se pudo confirmar el guardado. Conservá la ficha y reintentá.');
      // Una foto reemplazada deja de estar vinculada. Un fallo de limpieza no invalida el guardado.
      if (photoPath && photoPath !== path) await client.storage.from('inventory-photos').remove([photoPath]).catch(() => {});
      return saved;
    },
    async photoBlob(path) { return check(await client.storage.from('inventory-photos').download(path)); }
  };
}
