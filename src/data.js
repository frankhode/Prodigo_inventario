import { retryableTransferError } from './bulk-retry.js';
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
  async function uploadPhoto(id, userId, photo) {
    const digest = await crypto.subtle.digest('SHA-256',await photo.arrayBuffer());
    const hash = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2,'0')).join('');
    const path = `${userId}/${id}/${hash}.jpg`;
    const uploaded = await client.storage.from('inventory-photos').upload(path,photo,{contentType:'image/jpeg',upsert:false});
    if (uploaded.error && !['Duplicate','409'].includes(String(uploaded.error.error ?? uploaded.error.statusCode)) && !/already exists/i.test(uploaded.error.message)) throw uploaded.error;
    return path;
  }
  async function all(table) {
    const rows = [];
    for (let offset = 0;; offset += 500) {
      let query = client.from(table).select('*');
      query = table === 'inventory_items' || table === 'inventory_number_voids' ? query.order('number') : query.order('kind').order('category_key').order('parent_key').order('name_key');
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
      const [items,terms,voids] = await Promise.all([all('inventory_items'),all('inventory_terms'),all('inventory_number_voids')]);
      return {user,member,items,terms,voids};
    },
    async photoUrl(path) {
      const cached = photoUrls.get(path);
      if (cached?.expires > Date.now()) return cached.url;
      const result = check(await client.storage.from('inventory-photos').createSignedUrl(path,3600));
      photoUrls.set(path,{url:result.signedUrl,expires:Date.now()+45*60*1000}); return result.signedUrl;
    },
    async save({id,revision,values,photo,photoPath,previousPhotoPath = photoPath,userId,gallery,previousExtraPhotos = []}) {
      const extraFields = [];
      if (values.original_number) extraFields.push('original_number');
      if (values.photo_crop) extraFields.push('photo_crop');
      if (gallery?.length) extraFields.push('extra_photos');
      if (extraFields.length) {
        // Evitar que una base anterior descarte los campos al guardar.
        const schema = await client.from('inventory_items').select(extraFields.join(',')).limit(0);
        if (schema.error?.code === '42703') {
          const message = schema.error.message;
          const field = message.includes('extra_photos') ? 'La galería'
            : message.includes('photo_crop') ? 'El recorte' : 'La numeración original';
          throw Error(field + ' todavía no está disponible. Consultá a Pródigo.');
        }
        check(schema);
      }
      const path = photo ? await uploadPhoto(id,userId,photo) : photoPath;
      if (gallery) {
        const extras = new Set();
        for (const entry of gallery) extras.add(entry.path ?? await uploadPhoto(id,userId,entry.blob));
        extras.delete(path);
        values = {...values,extra_photos:[...extras]};
      }
      const result = check(await client.rpc('save_inventory_item',{p_id:id,p_revision:revision,p_values:values,p_photo_path:path}));
      const saved = Array.isArray(result) ? result[0] : result;
      if (!saved?.id || !saved.code) throw Error('No se pudo confirmar el guardado. Conservá la ficha y reintentá.');
      // Limpiar solo archivos que ya no están vinculados, después de confirmar el guardado.
      const retained = new Set([saved.photo_path ?? path,...(saved.extra_photos ?? [])]);
      const unused = [...new Set([previousPhotoPath,...previousExtraPhotos])].filter(path => path && !retained.has(path));
      if (unused.length) {
        for (const path of unused) photoUrls.delete(path);
        await client.storage.from('inventory-photos').remove(unused).catch(() => {});
      }
      return saved;
    },
    async importedCatalogKeys(collectionId) {
      if (!/^[a-z0-9-]+$/.test(collectionId)) throw Error('Colección inválida.');
      const keys = new Set();
      const prefix = `prodigo-catalogador:${collectionId}:`;
      for(let offset=0;;offset+=500) {
        const result=await client.from('inventory_bulk_images')
          .select('source_key').like('source_key',prefix+'%')
          .order('source_key').range(offset,offset+499);
        if(result.error?.code==='42703'||result.error?.code==='PGRST204')
          throw Error('Para importar el catalogador falta aplicar la migración 202611160003_catalog_import.sql en Supabase.');
        const rows=check(result);
        for(const row of rows)if(row.source_key)keys.add(row.source_key);
        if(rows.length<500)break;
      }
      return keys;
    },
    async pendingBulkCatalog() {
      const batches=[];
      for(let offset=0;;offset+=100) {
        const response=check(await client.from('inventory_bulk_batches').select('*')
          .order('created_at',{ascending:false}).range(offset,offset+99));
        batches.push(...response);
        if(response.length<100)break;
      }
      if(!batches.length)return [];
      const groups=await Promise.all(batches.map(async batch=>{
        const [images,slots]=await Promise.all([
          client.from('inventory_bulk_images').select('*').eq('batch_id',batch.id).order('ordinal'),
          client.from('inventory_bulk_slots').select('image_id').eq('batch_id',batch.id)
        ]);
        return {batch,details:{images:check(images),slots:check(slots)}};
      }));
      return groups;
    },
    async listBulkBatches() {
      return check(await client.from('inventory_bulk_batches').select('*')
        .order('created_at',{ascending:false}).limit(100));
    },
    async bulkBackupSnapshot() {
      const batches=[];
      for(let offset=0;;offset+=500) {
        const rows=check(await client.from('inventory_bulk_batches').select('*')
          .order('created_at',{ascending:false}).range(offset,offset+499));
        batches.push(...rows);
        if(rows.length<500)break;
      }
      const images=[],slots=[];
      for(const batch of batches) {
        const data=await this.bulkDetails(batch.id);
        images.push(...data.images);
        slots.push(...data.slots);
      }
      const labelEvents=[];
      for(let offset=0;;offset+=500) {
        const rows=check(await client.from('inventory_label_events').select('*')
          .order('id').range(offset,offset+499));
        labelEvents.push(...rows);
        if(rows.length<500)break;
      }
      return {batches,images,slots,labelEvents};
    },
    async bulkDetails(batchId) {
      const [images,slots] = await Promise.all([
        client.from('inventory_bulk_images').select('*').eq('batch_id',batchId).order('ordinal'),
        client.from('inventory_bulk_slots').select('*').eq('batch_id',batchId).order('ordinal')
      ]);
      const imageRows=check(images),slotRows=check(slots);
      const linkedIds=slotRows.map(slot=>slot.image_id).filter(Boolean);
      const linkedItems=[];
      for(let offset=0;offset<linkedIds.length;offset+=100) {
        const subset=linkedIds.slice(offset,offset+100);
        linkedItems.push(...check(await client.from('inventory_items')
          .select('id,number,code,revision,label_confirmed_at')
          .in('id',subset)));
      }
      return {images:imageRows,slots:slotRows,items:linkedItems};
    },
    async stageBulkPhoto(id,userId,blob) {
      return uploadPhoto(id,userId,blob);
    },
    async getBulkBatch(id) {
      return check(await client.from('inventory_bulk_batches')
        .select('*').eq('id',id).maybeSingle());
    },
    async createBulkBatch({id,expectedStart,common,images}) {
      const payload={p_id:id,p_expected_start:expectedStart,p_common:common,p_images:images};
      try {
        const result=await client.rpc('create_inventory_bulk_batch',payload);
        if(result.error?.code==='PGRST202') throw Error('La carga masiva todavía no está habilitada en Supabase. Aplicá la nueva migración.');
        return check(result);
      } catch(error) {
        // Una respuesta 520 puede llegar DESPUÉS de que la base confirmó.
        // Recuperar por el UUID original; nunca generar otro lote en silencio.
        if (!retryableTransferError(error)) throw error;
        let recorded=null;
        try {recorded=await this.getBulkBatch(id);}catch{}
        if(recorded){
          if(recorded.total!==images.length||Number(recorded.start_number)!==expectedStart)
            throw Error('El lote ya existe con otros datos. Revisá su numeración antes de continuar.');
          return recorded;
        }
        const uncertain=Error('La comunicación con Supabase se interrumpió durante la reserva. No sabemos si se creó el lote. Revisá “Lotes existentes” o consultá la tabla inventory_bulk_batches antes de reintentar; NO generes una reserva nueva.');
        uncertain.cause=error;
        uncertain.code='BULK_RESERVATION_UNCERTAIN';
        throw uncertain;
      }
    },
    async assignBulkImage({batchId,imageId,expectedNumber,details}) {
      const result = await client.rpc('assign_inventory_bulk_image',{
        p_batch_id:batchId,p_image_id:imageId,p_expected_number:expectedNumber,p_details:details
      });
      if (result.error?.code === 'PGRST202') throw Error('La asignación masiva todavía no está habilitada en Supabase.');
      return check(result);
    },
    async discardUnreservedBulkFiles(paths) {
      if (!paths.length) return;
      // Solo se puede limpiar material temporal todavía no reservado.
      check(await client.storage.from('inventory-photos').remove(paths));
    },
    async setLabel({id,revision,labeled}) {
      const result = await client.rpc('set_inventory_label',{p_id:id,p_revision:revision,p_labeled:labeled});
      if (result.error?.code === 'PGRST202') throw Error('El etiquetado todavía no está habilitado en Supabase. Aplicá la migración de etiquetado.');
      const saved = check(result);
      if (!saved?.id || typeof saved.revision !== 'number') throw Error('No se pudo confirmar el estado de la etiqueta.');
      return saved;
    },
    async remove({id,revision,photoPath,extraPhotos = [],reason = 'Anulación solicitada desde el inventario'}) {
      const result = await client.rpc('void_inventory_item',{p_id:id,p_revision:revision,p_reason:reason});
      if (result.error?.code === 'PGRST202') throw Error('La opción de borrar todavía no está habilitada. Consultá a Pródigo.');
      const path = check(result) || photoPath;
      const paths = [...new Set([path,...extraPhotos].filter(Boolean))];
      for (const path of paths) photoUrls.delete(path);
      // Los archivos solo se quitan después del borrado confirmado.
      let photoCleanupFailed = false;
      if (paths.length) {
        try { photoCleanupFailed = !!(await client.storage.from('inventory-photos').remove(paths)).error; }
        catch { photoCleanupFailed = true; }
      }
      return {photoCleanupFailed};
    },
    async photoBlob(path) { return check(await client.storage.from('inventory-photos').download(path)); }
  };
}
