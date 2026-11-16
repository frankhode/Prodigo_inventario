-- Numeración: P000001–P000999 para máquinas de escribir;
-- P001000 en adelante para fotografías y demás materiales.
-- Requiere las migraciones 202611160001, 002 y 003.
-- Conserva todos los identificadores existentes y NO anula 367–999.
begin;

-- Nunca desplazar una secuencia preexistente ni forzar setval sobre la principal.
create sequence if not exists public.inventory_other_number_seq
  as bigint minvalue 1000 maxvalue 999999 start with 1000 increment by 1 no cycle;
revoke all on sequence public.inventory_other_number_seq from public,anon,authenticated;
do $$
declare v_next bigint;
begin
  select greatest(1000,coalesce(max(number)+1,1000)) into v_next from (
    select number from public.inventory_items where number>=1000
    union all select number from public.inventory_bulk_slots where number>=1000
    union all select number from public.inventory_number_voids where number>=1000
  ) used;
  if v_next>999999 then raise exception 'No hay números disponibles desde P001000.'; end if;
  perform setval('public.inventory_other_number_seq',v_next,false);
end;
$$;

create or replace function public.save_inventory_item(p_id uuid, p_revision integer, p_values jsonb, p_photo_path text)
returns public.inventory_items language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  previous public.inventory_items;
  saved public.inventory_items;
  v_category text; v_brand text; v_model text; v_type text;
  v_date text := btrim(coalesce(p_values->>'manufacture_date',''));
  v_original_number text;
  v_crop jsonb;
  v_extra_photos text[];
  v_extra_path text;
  v_notes text := btrim(coalesce(p_values->>'notes',''));
  v_destination text := p_values->>'destination';
  v_last bigint;
  v_called boolean;
begin
  if actor is null or not public.inventory_is_member() then
    raise exception 'No tenés acceso a este inventario.' using errcode = '42501';
  end if;
  if p_id is null or p_revision is null or p_revision < 0 then
    raise exception 'Identificador o revisión inválidos.' using errcode = '22023';
  end if;
  -- Serializa los reintentos de una misma alta, incluso antes de que exista su fila.
  perform pg_advisory_xact_lock(hashtextextended(p_id::text,0));
  select * into previous from public.inventory_items where id = p_id for update;
  if previous.id is null and p_revision <> 0 then
    raise exception 'La ficha ya no está disponible.' using errcode = '40001';
  end if;
  if previous.id is not null and p_revision <> 0 and previous.revision <> p_revision then
    raise exception 'Otra persona modificó esta ficha. Conservá tus datos y actualizá antes de guardar.' using errcode = '40001';
  end if;
  if p_values ? 'photo_crop' then
    v_crop := nullif(p_values->'photo_crop','null'::jsonb);
  elsif previous.photo_path = p_photo_path then
    v_crop := previous.photo_crop;
  end if;
  -- Los clientes anteriores omiten el campo. Un texto vacío explícito permite borrarlo.
  v_original_number := btrim(coalesce(p_values->>'original_number', previous.original_number, ''));
  if length(v_original_number) > 120 then
    raise exception 'La numeración original admite hasta 120 caracteres.' using errcode = '22023';
  end if;
  if v_destination is null or v_destination not in ('museo','tienda','otros') then
    raise exception 'Elegí un destino.' using errcode = '22023';
  end if;
  if length(v_date) > 80 or length(v_notes) > 4000 then
    raise exception 'La fecha o las notas son demasiado extensas.' using errcode = '22023';
  end if;
  v_category := public.inventory_term('category','','',p_values->>'category');
  if v_category = '' then raise exception 'Elegí el objeto.' using errcode = '22023'; end if;
  v_brand := public.inventory_term('brand',v_category,'',p_values->>'brand');
  if v_brand = '' and btrim(coalesce(p_values->>'model','')) <> '' then
    raise exception 'Elegí una marca antes de consignar el modelo.' using errcode = '22023';
  end if;
  v_model := public.inventory_term('model',v_category,v_brand,p_values->>'model');
  v_type := public.inventory_term('type',v_category,'',p_values->>'type');
  -- Una foto nueva debe pertenecer a quien guarda y al UUID de esta ficha.
  -- La foto actual puede mantenerse al editar la ficha de otro integrante.
  if previous.id is null or (p_photo_path is distinct from previous.photo_path
    and not coalesce(p_photo_path = any(previous.extra_photos),false)) then
    if p_photo_path is null or p_photo_path !~ (
      '^' || actor::text || '/' || p_id::text || '/[a-f0-9]{64}\.jpg$')
      or not exists(select 1 from storage.objects where bucket_id = 'inventory-photos' and name = p_photo_path) then
      raise exception 'Subí una foto válida antes de guardar.' using errcode = '22023';
    end if;
  end if;
  v_extra_photos := coalesce(previous.extra_photos,'{}'::text[]);
  if p_values ? 'extra_photos' then
    if jsonb_typeof(p_values->'extra_photos') is distinct from 'array' then
      raise exception 'La galería debe ser una lista de fotos.' using errcode = '22023';
    end if;
    if jsonb_array_length(p_values->'extra_photos') > 7 then
      raise exception 'Se admiten hasta siete fotos adicionales.' using errcode = '22023';
    end if;
    v_extra_photos := array(select jsonb_array_elements_text(p_values->'extra_photos'));
  end if;
  v_extra_photos := array_remove(v_extra_photos,p_photo_path);
  if cardinality(v_extra_photos) <> (select count(distinct path) from unnest(v_extra_photos) as photo(path)) then
    raise exception 'La galería tiene fotos repetidas o inválidas.' using errcode = '22023';
  end if;
  foreach v_extra_path in array v_extra_photos loop
    if v_extra_path = previous.photo_path or v_extra_path = any(coalesce(previous.extra_photos,'{}'::text[])) then continue; end if;
    if v_extra_path !~ ('^' || actor::text || '/' || p_id::text || '/[a-f0-9]{64}\.jpg$')
      or not exists(select 1 from storage.objects where bucket_id = 'inventory-photos' and name = v_extra_path) then
      raise exception 'Subí fotos válidas para esta ficha.' using errcode = '22023';
    end if;
  end loop;

  if previous.id is not null and p_revision = 0 then
    -- Un alta cuya respuesta se perdió se puede repetir sin duplicar el objeto.
    if previous.created_by = actor and previous.revision = 1
      and (previous.category,previous.brand,previous.model,previous.manufacture_date,previous.original_number,previous.type,previous.destination,previous.notes,previous.photo_path,previous.photo_crop,previous.extra_photos)
      is not distinct from (v_category,v_brand,v_model,v_date,v_original_number,v_type,v_destination,v_notes,p_photo_path,v_crop,v_extra_photos) then
      return previous;
    end if;
    raise exception 'Esta ficha ya fue guardada. Actualizá el inventario antes de continuar.' using errcode = '40001';
  end if;
  if previous.id is null then
    -- Un solo candado para altas individuales y reservas masivas de ambos rangos.
    lock table public.inventory_items in share row exclusive mode;
    if lower(v_category) = lower('Máquina de escribir') then
      select last_value,is_called into v_last,v_called from public.inventory_items_number_seq;
      if v_last + (case when v_called then 1 else 0 end) > 999 then
        raise exception 'El rango P000001–P000999 reservado a máquinas de escribir está completo.'
          using errcode='22023';
      end if;
      insert into public.inventory_items(id,category,brand,model,manufacture_date,original_number,type,destination,notes,photo_path,photo_crop,extra_photos,created_by,updated_by)
        values(p_id,v_category,v_brand,v_model,v_date,v_original_number,v_type,v_destination,v_notes,p_photo_path,v_crop,v_extra_photos,actor,actor)
        returning * into saved;
    else
      insert into public.inventory_items(id,number,category,brand,model,manufacture_date,original_number,type,destination,notes,photo_path,photo_crop,extra_photos,created_by,updated_by)
        overriding system value
        values(p_id,nextval('public.inventory_other_number_seq'),v_category,v_brand,v_model,v_date,v_original_number,v_type,v_destination,v_notes,p_photo_path,v_crop,v_extra_photos,actor,actor)
        returning * into saved;
    end if;
  else
    update public.inventory_items set category=v_category, brand=v_brand, model=v_model,
      manufacture_date=v_date, original_number=v_original_number, type=v_type, destination=v_destination, notes=v_notes,
      photo_path=p_photo_path, photo_crop=v_crop, extra_photos=v_extra_photos, revision=revision+1, updated_at=now(), updated_by=actor
      where id=p_id returning * into saved;
  end if;
  return saved;
end;
$$;

revoke all on function public.save_inventory_item(uuid,integer,jsonb,text) from public,anon;
grant execute on function public.save_inventory_item(uuid,integer,jsonb,text) to authenticated;

create or replace function public.create_inventory_bulk_batch(
  p_id uuid,p_expected_start bigint,p_common jsonb,p_images jsonb
) returns public.inventory_bulk_batches
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  existing public.inventory_bulk_batches;
  saved public.inventory_bulk_batches;
  item jsonb;
  n integer;
  k integer := 0;
  image_id uuid;
  original_name text;
  path text;
  extra_path text;
  v_source_key text;
  v_number bigint;
  seq_last bigint;
  seq_called boolean;
  actual_start bigint;
  number_sequence text;
  machine_range boolean;
begin
  if actor is null or not public.inventory_is_member() then
    raise exception 'No tenés acceso a este inventario.' using errcode = '42501';
  end if;
  if p_id is null or p_expected_start is null or p_expected_start < 1 then
    raise exception 'Indicá el número de la próxima etiqueta preimpresa.' using errcode = '22023';
  end if;
  if jsonb_typeof(p_common) is distinct from 'object'
    or length(btrim(coalesce(p_common->>'category',''))) = 0
    or coalesce(p_common->>'destination','') not in ('museo','tienda','otros') then
    raise exception 'Elegí el tipo de objeto y el destino del lote.' using errcode = '22023';
  end if;
  if jsonb_typeof(p_images) is distinct from 'array' then
    raise exception 'La selección de imágenes es inválida.' using errcode = '22023';
  end if;
  n := jsonb_array_length(p_images);
  if n < 1 or n > 500 then
    raise exception 'Elegí entre 1 y 500 imágenes por lote.' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_id::text,0));
  select * into existing from public.inventory_bulk_batches where id=p_id;
  if existing.id is not null then
    if existing.created_by <> actor or existing.total <> n or existing.start_number <> p_expected_start then
      raise exception 'El lote ya existe y no coincide con este intento.' using errcode = '40001';
    end if;
    return existing;
  end if;
  -- Se verifica cada foto ANTES de consumir cualquier número.
  for item in select value from jsonb_array_elements(p_images) loop
    k := k + 1;
    if jsonb_typeof(item) is distinct from 'object' then
      raise exception 'Imagen inválida en la posición %.',k using errcode='22023';
    end if;
    image_id := (item->>'id')::uuid;
    path := item->>'photo_path';
    original_name := btrim(coalesce(item->>'original_filename',''));
    if length(original_name) < 1 or length(original_name) > 250 or image_id is null
      or path is null or path !~ ('^'||actor::text||'/'||image_id::text||'/[a-f0-9]{64}[.]jpg$')
      or not exists (select 1 from storage.objects where bucket_id='inventory-photos' and name=path) then
      raise exception 'Imagen % sin archivo válido o nombre original.',k using errcode='22023';
    end if;

    if item ? 'image_values' and jsonb_typeof(item->'image_values') is distinct from 'object' then
      raise exception 'Metadatos individuales inválidos.' using errcode='22023';
    end if;
    if item ? 'extra_photos' and jsonb_typeof(item->'extra_photos') is distinct from 'array' then
      raise exception 'Las imágenes vinculadas deben ser una lista.' using errcode='22023';
    end if;
    if jsonb_array_length(coalesce(item->'extra_photos','[]'::jsonb)) > 7 then
      raise exception 'Hasta siete imágenes vinculadas por fotografía.' using errcode='22023';
    end if;
    for extra_path in
      select value from jsonb_array_elements_text(coalesce(item->'extra_photos','[]'::jsonb)) as extras(value)
    loop
      if extra_path = path or extra_path !~ ('^'||actor::text||'/'||image_id::text||'/[a-f0-9]{64}[.]jpg$')
        or not exists(select 1 from storage.objects where bucket_id='inventory-photos' and name=extra_path) then
        raise exception 'Imagen complementaria inválida en la posición %.',k using errcode='22023';
      end if;
    end loop;
    if (select count(*) from jsonb_array_elements_text(coalesce(item->'extra_photos','[]'::jsonb)))
      <> (select count(distinct value) from jsonb_array_elements_text(coalesce(item->'extra_photos','[]'::jsonb)) as extras(value)) then
      raise exception 'Hay fotografías complementarias duplicadas.' using errcode='22023';
    end if;
    v_source_key := nullif(btrim(coalesce(item->>'source_key','')),'');
    if v_source_key is not null then
      if length(v_source_key)>200 or v_source_key !~ '^prodigo-catalogador:[a-z0-9-]+:[a-f0-9]{64}$' then
        raise exception 'Identificador de origen inválido.' using errcode='22023';
      end if;
      if jsonb_typeof(item->'source_data') is distinct from 'object' then
        raise exception 'Falta el registro de origen de la fotografía.' using errcode='22023';
      end if;
      if exists(select 1 from public.inventory_bulk_images bi where bi.source_key=v_source_key) then
        raise exception 'La fotografía ya está incorporada en otro lote.' using errcode='23505';
      end if;
    end if;
  end loop;
  -- Bloquea INSERT normales, incluidos los clientes antiguos, mientras se
  -- obtiene un rango ininterrumpido de la secuencia compartida.
  lock table public.inventory_items in share row exclusive mode;
  machine_range := lower(btrim(p_common->>'category'))=lower('Máquina de escribir');
  number_sequence := case when machine_range
    then 'public.inventory_items_number_seq' else 'public.inventory_other_number_seq' end;
  if machine_range then
    select last_value,is_called into seq_last,seq_called from public.inventory_items_number_seq;
  else
    select last_value,is_called into seq_last,seq_called from public.inventory_other_number_seq;
  end if;
  actual_start := seq_last + (case when seq_called then 1 else 0 end);
  if actual_start <> p_expected_start then
    raise exception 'La próxima etiqueta para % debe ser P%. Se solicitaron números de otro rango.',
      case when machine_range then 'máquinas de escribir' else 'fotografías y otros materiales' end,
      lpad(actual_start::text,6,'0') using errcode='40001';
  end if;
  if actual_start + n - 1 > (case when machine_range then 999 else 999999 end) then
    raise exception 'Este lote supera el rango disponible para su tipo de material.' using errcode='22023';
  end if;
  insert into public.inventory_bulk_batches(id,created_by,common_values,total,start_number,end_number)
  values(p_id,actor,p_common,n,actual_start,actual_start+n-1) returning * into saved;
  k := 0;
  for item in select value from jsonb_array_elements(p_images) loop
    k := k+1;
    insert into public.inventory_bulk_images(
      id,batch_id,ordinal,original_filename,photo_path,image_values,extra_photos,source_key,source_data
    ) values (
      (item->>'id')::uuid,p_id,k,btrim(item->>'original_filename'),item->>'photo_path',
      coalesce(item->'image_values','{}'::jsonb),
      array(select value from jsonb_array_elements_text(coalesce(item->'extra_photos','[]'::jsonb)) as extras(value)),
      nullif(btrim(coalesce(item->>'source_key','')),''),
      coalesce(item->'source_data','{}'::jsonb)
    );
    v_number := nextval(number_sequence::regclass);
    insert into public.inventory_bulk_slots(number,batch_id,ordinal) values(v_number,p_id,k);
  end loop;
  return saved;
end;
$$;

revoke all on function public.create_inventory_bulk_batch(uuid,bigint,jsonb,jsonb) from public,anon;
grant execute on function public.create_inventory_bulk_batch(uuid,bigint,jsonb,jsonb) to authenticated;

create or replace function public.next_inventory_number(p_category text)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_last bigint; v_called boolean; v_next bigint;
begin
  if auth.uid() is null or not public.inventory_is_member() then
    raise exception 'No tenés acceso a este inventario.' using errcode='42501';
  end if;
  if lower(btrim(coalesce(p_category,'')))=lower('Máquina de escribir') then
    select last_value,is_called into v_last,v_called from public.inventory_items_number_seq;
    v_next:=v_last + (case when v_called then 1 else 0 end);
    if v_next>999 then raise exception 'Se completó el rango de máquinas de escribir.' using errcode='22023'; end if;
  else
    select last_value,is_called into v_last,v_called from public.inventory_other_number_seq;
    v_next:=v_last + (case when v_called then 1 else 0 end);
    if v_next>999999 then raise exception 'Se completó el rango de inventarios.' using errcode='22023'; end if;
  end if;
  return v_next;
end;
$$;
revoke all on function public.next_inventory_number(text) from public,anon;
grant execute on function public.next_inventory_number(text) to authenticated;
notify pgrst,'reload schema';
commit;
