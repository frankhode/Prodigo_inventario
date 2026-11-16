-- Importación del catalogador fotográfico: conservar frentes, imágenes relacionadas
-- y todos los metadatos con procedencia trazable. Aplicar después de 202611160002.
begin;

alter table public.inventory_bulk_images
  add column if not exists extra_photos text[] not null default '{}'::text[],
  add column if not exists source_key text,
  add column if not exists source_data jsonb not null default '{}'::jsonb;
alter table public.inventory_bulk_images
  add constraint inventory_bulk_source_key_size
  check (source_key is null or length(source_key) <= 200);
create unique index if not exists inventory_bulk_source_key_unique
  on public.inventory_bulk_images(source_key) where source_key is not null;

alter table public.inventory_items
  add column if not exists catalog_source jsonb not null default '{}'::jsonb;

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
  source_key text;
  v_number bigint;
  seq_last bigint;
  seq_called boolean;
  actual_start bigint;
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
      if extra_path = path or extra_path !~ ('^'||actor::text||'/'||image_id::text||'/[a-f0-9]{64}[.]jpg
  end loop;
  -- Bloquea INSERT normales, incluidos los clientes antiguos, mientras se
  -- obtiene un rango ininterrumpido de la secuencia compartida.
  lock table public.inventory_items in share row exclusive mode;
  select last_value,is_called into seq_last,seq_called from public.inventory_items_number_seq;
  actual_start := seq_last + (case when seq_called then 1 else 0 end);
  if actual_start <> p_expected_start then
    raise exception 'La próxima etiqueta debe ser P%. El número indicado no coincide con el correlativo disponible.',
      lpad(actual_start::text,6,'0') using errcode='40001';
  end if;
  if actual_start + n - 1 > 999999 then
    raise exception 'No quedan números de inventario suficientes.' using errcode='22023';
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
    v_number := nextval('public.inventory_items_number_seq');
    insert into public.inventory_bulk_slots(number,batch_id,ordinal) values(v_number,p_id,k);
  end loop;
  return saved;
end;
$$;
revoke all on function public.create_inventory_bulk_batch(uuid,bigint,jsonb,jsonb) from public,anon;
grant execute on function public.create_inventory_bulk_batch(uuid,bigint,jsonb,jsonb) to authenticated;

create or replace function public.assign_inventory_bulk_image(
  p_batch_id uuid,p_image_id uuid,p_expected_number bigint,p_details jsonb
) returns public.inventory_items
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  batch public.inventory_bulk_batches;
  image_row public.inventory_bulk_images;
  slot public.inventory_bulk_slots;
  saved public.inventory_items;
  val jsonb;
  v_category text; v_brand text; v_model text; v_type text;
  v_date text; v_original text; v_notes text; v_destination text;
begin
  if actor is null or not public.inventory_is_member() then
    raise exception 'No tenés acceso a este inventario.' using errcode='42501';
  end if;
  if p_batch_id is null or p_image_id is null or p_expected_number is null
    or jsonb_typeof(coalesce(p_details,'{}'::jsonb)) is distinct from 'object' then
    raise exception 'Selección o metadatos inválidos.' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_batch_id::text,0));
  select * into batch from public.inventory_bulk_batches where id=p_batch_id for update;
  if batch.id is null then
    raise exception 'El lote ya no está disponible.' using errcode='22023';
  end if;
  select * into image_row from public.inventory_bulk_images
    where id=p_image_id and batch_id=p_batch_id for update;
  if image_row.id is null then
    raise exception 'Imagen inexistente en este lote.' using errcode='22023';
  end if;
  select * into slot from public.inventory_bulk_slots
    where batch_id=p_batch_id and image_id=p_image_id;
  if slot.number is not null then
    if slot.number <> p_expected_number then
      raise exception 'La fotografía ya tiene otro número asociado.' using errcode='40001';
    end if;
    select * into saved from public.inventory_items where id=image_row.id;
    if saved.id is null then
      raise exception 'El registro asociado a esta fotografía fue anulado.' using errcode='40001';
    end if;
    return saved;
  end if;
  select * into slot from public.inventory_bulk_slots
    where batch_id=p_batch_id and image_id is null
    order by ordinal limit 1 for update;
  if slot.number is null then
    raise exception 'Todos los números del lote ya fueron asignados.' using errcode='40001';
  end if;
  if slot.number <> p_expected_number then
    raise exception 'La próxima etiqueta física es P%. Actualizá el lote antes de continuar.',
      lpad(slot.number::text,6,'0') using errcode='40001';
  end if;
  val := batch.common_values || image_row.image_values || coalesce(p_details,'{}'::jsonb);
  v_destination := val->>'destination';
  if coalesce(v_destination,'') not in ('museo','tienda','otros') then
    raise exception 'Destino inválido.' using errcode='22023';
  end if;
  v_date := btrim(coalesce(val->>'manufacture_date',''));
  v_original := btrim(coalesce(val->>'original_number',''));
  v_notes := btrim(coalesce(val->>'notes',''));
  if length(v_date)>80 or length(v_original)>120 or length(v_notes)>4000 then
    raise exception 'Los metadatos superan la extensión permitida.' using errcode='22023';
  end if;
  v_category := public.inventory_term('category','','',val->>'category');
  if v_category = '' then raise exception 'Elegí el tipo de objeto.' using errcode='22023'; end if;
  v_brand := public.inventory_term('brand',v_category,'',val->>'brand');
  if v_brand = '' and btrim(coalesce(val->>'model',''))<>'' then
    raise exception 'Elegí una marca o autor antes de indicar el modelo.' using errcode='22023';
  end if;
  v_model := public.inventory_term('model',v_category,v_brand,val->>'model');
  v_type := public.inventory_term('type',v_category,'',val->>'type');
  insert into public.inventory_items(id,number,category,brand,model,manufacture_date,
    original_number,type,destination,notes,photo_path,extra_photos,catalog_source,created_by,updated_by)
    overriding system value
  values(image_row.id,slot.number,v_category,v_brand,v_model,v_date,v_original,v_type,
    v_destination,v_notes,image_row.photo_path,image_row.extra_photos,image_row.source_data,actor,actor)
  returning * into saved;
  update public.inventory_bulk_slots
    set image_id=image_row.id,assigned_by=actor,assigned_at=now()
    where number=slot.number;
  -- Solo se vincula el número: todavía NO se ha pegado la etiqueta.
  -- El operador confirma la colocación mediante set_inventory_label después.
  return saved;
end;
$$;
revoke all on function public.assign_inventory_bulk_image(uuid,uuid,bigint,jsonb) from public,anon;
grant execute on function public.assign_inventory_bulk_image(uuid,uuid,bigint,jsonb) to authenticated;

)
        or not exists(select 1 from storage.objects where bucket_id='inventory-photos' and name=extra_path) then
        raise exception 'Imagen complementaria inválida en la posición %.',k using errcode='22023';
      end if;
    end loop;
    if (select count(*) from jsonb_array_elements_text(coalesce(item->'extra_photos','[]'::jsonb)))
      <> (select count(distinct value) from jsonb_array_elements_text(coalesce(item->'extra_photos','[]'::jsonb)) as extras(value)) then
      raise exception 'Hay fotografías complementarias duplicadas.' using errcode='22023';
    end if;
    source_key := nullif(btrim(coalesce(item->>'source_key','')),'');
    if source_key is not null then
      if length(source_key)>200 or source_key !~ '^prodigo-catalogador:[a-z0-9-]+:[a-f0-9]{64}
  end loop;
  -- Bloquea INSERT normales, incluidos los clientes antiguos, mientras se
  -- obtiene un rango ininterrumpido de la secuencia compartida.
  lock table public.inventory_items in share row exclusive mode;
  select last_value,is_called into seq_last,seq_called from public.inventory_items_number_seq;
  actual_start := seq_last + (case when seq_called then 1 else 0 end);
  if actual_start <> p_expected_start then
    raise exception 'La próxima etiqueta debe ser P%. El número indicado no coincide con el correlativo disponible.',
      lpad(actual_start::text,6,'0') using errcode='40001';
  end if;
  if actual_start + n - 1 > 999999 then
    raise exception 'No quedan números de inventario suficientes.' using errcode='22023';
  end if;
  insert into public.inventory_bulk_batches(id,created_by,common_values,total,start_number,end_number)
  values(p_id,actor,p_common,n,actual_start,actual_start+n-1) returning * into saved;
  k := 0;
  for item in select value from jsonb_array_elements(p_images) loop
    k := k+1;
    insert into public.inventory_bulk_images(id,batch_id,ordinal,original_filename,photo_path,image_values)
    values((item->>'id')::uuid,p_id,k,btrim(item->>'original_filename'),item->>'photo_path',
      coalesce(item->'image_values','{}'::jsonb));
    v_number := nextval('public.inventory_items_number_seq');
    insert into public.inventory_bulk_slots(number,batch_id,ordinal) values(v_number,p_id,k);
  end loop;
  return saved;
end;
$$;
revoke all on function public.create_inventory_bulk_batch(uuid,bigint,jsonb,jsonb) from public,anon;
grant execute on function public.create_inventory_bulk_batch(uuid,bigint,jsonb,jsonb) to authenticated;

create or replace function public.assign_inventory_bulk_image(
  p_batch_id uuid,p_image_id uuid,p_expected_number bigint,p_details jsonb
) returns public.inventory_items
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  batch public.inventory_bulk_batches;
  image_row public.inventory_bulk_images;
  slot public.inventory_bulk_slots;
  saved public.inventory_items;
  val jsonb;
  v_category text; v_brand text; v_model text; v_type text;
  v_date text; v_original text; v_notes text; v_destination text;
begin
  if actor is null or not public.inventory_is_member() then
    raise exception 'No tenés acceso a este inventario.' using errcode='42501';
  end if;
  if p_batch_id is null or p_image_id is null or p_expected_number is null
    or jsonb_typeof(coalesce(p_details,'{}'::jsonb)) is distinct from 'object' then
    raise exception 'Selección o metadatos inválidos.' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_batch_id::text,0));
  select * into batch from public.inventory_bulk_batches where id=p_batch_id for update;
  if batch.id is null then
    raise exception 'El lote ya no está disponible.' using errcode='22023';
  end if;
  select * into image_row from public.inventory_bulk_images
    where id=p_image_id and batch_id=p_batch_id for update;
  if image_row.id is null then
    raise exception 'Imagen inexistente en este lote.' using errcode='22023';
  end if;
  select * into slot from public.inventory_bulk_slots
    where batch_id=p_batch_id and image_id=p_image_id;
  if slot.number is not null then
    if slot.number <> p_expected_number then
      raise exception 'La fotografía ya tiene otro número asociado.' using errcode='40001';
    end if;
    select * into saved from public.inventory_items where id=image_row.id;
    if saved.id is null then
      raise exception 'El registro asociado a esta fotografía fue anulado.' using errcode='40001';
    end if;
    return saved;
  end if;
  select * into slot from public.inventory_bulk_slots
    where batch_id=p_batch_id and image_id is null
    order by ordinal limit 1 for update;
  if slot.number is null then
    raise exception 'Todos los números del lote ya fueron asignados.' using errcode='40001';
  end if;
  if slot.number <> p_expected_number then
    raise exception 'La próxima etiqueta física es P%. Actualizá el lote antes de continuar.',
      lpad(slot.number::text,6,'0') using errcode='40001';
  end if;
  val := batch.common_values || image_row.image_values || coalesce(p_details,'{}'::jsonb);
  v_destination := val->>'destination';
  if coalesce(v_destination,'') not in ('museo','tienda','otros') then
    raise exception 'Destino inválido.' using errcode='22023';
  end if;
  v_date := btrim(coalesce(val->>'manufacture_date',''));
  v_original := btrim(coalesce(val->>'original_number',''));
  v_notes := btrim(coalesce(val->>'notes',''));
  if length(v_date)>80 or length(v_original)>120 or length(v_notes)>4000 then
    raise exception 'Los metadatos superan la extensión permitida.' using errcode='22023';
  end if;
  v_category := public.inventory_term('category','','',val->>'category');
  if v_category = '' then raise exception 'Elegí el tipo de objeto.' using errcode='22023'; end if;
  v_brand := public.inventory_term('brand',v_category,'',val->>'brand');
  if v_brand = '' and btrim(coalesce(val->>'model',''))<>'' then
    raise exception 'Elegí una marca o autor antes de indicar el modelo.' using errcode='22023';
  end if;
  v_model := public.inventory_term('model',v_category,v_brand,val->>'model');
  v_type := public.inventory_term('type',v_category,'',val->>'type');
  insert into public.inventory_items(id,number,category,brand,model,manufacture_date,
    original_number,type,destination,notes,photo_path,created_by,updated_by)
    overriding system value
  values(image_row.id,slot.number,v_category,v_brand,v_model,v_date,v_original,v_type,
    v_destination,v_notes,image_row.photo_path,actor,actor)
  returning * into saved;
  update public.inventory_bulk_slots
    set image_id=image_row.id,assigned_by=actor,assigned_at=now()
    where number=slot.number;
  -- Solo se vincula el número: todavía NO se ha pegado la etiqueta.
  -- El operador confirma la colocación mediante set_inventory_label después.
  return saved;
end;
$$;
revoke all on function public.assign_inventory_bulk_image(uuid,uuid,bigint,jsonb) from public,anon;
grant execute on function public.assign_inventory_bulk_image(uuid,uuid,bigint,jsonb) to authenticated;

 then
        raise exception 'Identificador de origen inválido.' using errcode='22023';
      end if;
      if jsonb_typeof(item->'source_data') is distinct from 'object' then
        raise exception 'Falta el registro de origen de la fotografía.' using errcode='22023';
      end if;
      if exists(select 1 from public.inventory_bulk_images where source_key=source_key) then
        raise exception 'La fotografía ya está incorporada en otro lote.' using errcode='23505';
      end if;
    end if;
  end loop;
  -- Bloquea INSERT normales, incluidos los clientes antiguos, mientras se
  -- obtiene un rango ininterrumpido de la secuencia compartida.
  lock table public.inventory_items in share row exclusive mode;
  select last_value,is_called into seq_last,seq_called from public.inventory_items_number_seq;
  actual_start := seq_last + (case when seq_called then 1 else 0 end);
  if actual_start <> p_expected_start then
    raise exception 'La próxima etiqueta debe ser P%. El número indicado no coincide con el correlativo disponible.',
      lpad(actual_start::text,6,'0') using errcode='40001';
  end if;
  if actual_start + n - 1 > 999999 then
    raise exception 'No quedan números de inventario suficientes.' using errcode='22023';
  end if;
  insert into public.inventory_bulk_batches(id,created_by,common_values,total,start_number,end_number)
  values(p_id,actor,p_common,n,actual_start,actual_start+n-1) returning * into saved;
  k := 0;
  for item in select value from jsonb_array_elements(p_images) loop
    k := k+1;
    insert into public.inventory_bulk_images(id,batch_id,ordinal,original_filename,photo_path,image_values)
    values((item->>'id')::uuid,p_id,k,btrim(item->>'original_filename'),item->>'photo_path',
      coalesce(item->'image_values','{}'::jsonb));
    v_number := nextval('public.inventory_items_number_seq');
    insert into public.inventory_bulk_slots(number,batch_id,ordinal) values(v_number,p_id,k);
  end loop;
  return saved;
end;
$$;
revoke all on function public.create_inventory_bulk_batch(uuid,bigint,jsonb,jsonb) from public,anon;
grant execute on function public.create_inventory_bulk_batch(uuid,bigint,jsonb,jsonb) to authenticated;

create or replace function public.assign_inventory_bulk_image(
  p_batch_id uuid,p_image_id uuid,p_expected_number bigint,p_details jsonb
) returns public.inventory_items
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  batch public.inventory_bulk_batches;
  image_row public.inventory_bulk_images;
  slot public.inventory_bulk_slots;
  saved public.inventory_items;
  val jsonb;
  v_category text; v_brand text; v_model text; v_type text;
  v_date text; v_original text; v_notes text; v_destination text;
begin
  if actor is null or not public.inventory_is_member() then
    raise exception 'No tenés acceso a este inventario.' using errcode='42501';
  end if;
  if p_batch_id is null or p_image_id is null or p_expected_number is null
    or jsonb_typeof(coalesce(p_details,'{}'::jsonb)) is distinct from 'object' then
    raise exception 'Selección o metadatos inválidos.' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_batch_id::text,0));
  select * into batch from public.inventory_bulk_batches where id=p_batch_id for update;
  if batch.id is null then
    raise exception 'El lote ya no está disponible.' using errcode='22023';
  end if;
  select * into image_row from public.inventory_bulk_images
    where id=p_image_id and batch_id=p_batch_id for update;
  if image_row.id is null then
    raise exception 'Imagen inexistente en este lote.' using errcode='22023';
  end if;
  select * into slot from public.inventory_bulk_slots
    where batch_id=p_batch_id and image_id=p_image_id;
  if slot.number is not null then
    if slot.number <> p_expected_number then
      raise exception 'La fotografía ya tiene otro número asociado.' using errcode='40001';
    end if;
    select * into saved from public.inventory_items where id=image_row.id;
    if saved.id is null then
      raise exception 'El registro asociado a esta fotografía fue anulado.' using errcode='40001';
    end if;
    return saved;
  end if;
  select * into slot from public.inventory_bulk_slots
    where batch_id=p_batch_id and image_id is null
    order by ordinal limit 1 for update;
  if slot.number is null then
    raise exception 'Todos los números del lote ya fueron asignados.' using errcode='40001';
  end if;
  if slot.number <> p_expected_number then
    raise exception 'La próxima etiqueta física es P%. Actualizá el lote antes de continuar.',
      lpad(slot.number::text,6,'0') using errcode='40001';
  end if;
  val := batch.common_values || image_row.image_values || coalesce(p_details,'{}'::jsonb);
  v_destination := val->>'destination';
  if coalesce(v_destination,'') not in ('museo','tienda','otros') then
    raise exception 'Destino inválido.' using errcode='22023';
  end if;
  v_date := btrim(coalesce(val->>'manufacture_date',''));
  v_original := btrim(coalesce(val->>'original_number',''));
  v_notes := btrim(coalesce(val->>'notes',''));
  if length(v_date)>80 or length(v_original)>120 or length(v_notes)>4000 then
    raise exception 'Los metadatos superan la extensión permitida.' using errcode='22023';
  end if;
  v_category := public.inventory_term('category','','',val->>'category');
  if v_category = '' then raise exception 'Elegí el tipo de objeto.' using errcode='22023'; end if;
  v_brand := public.inventory_term('brand',v_category,'',val->>'brand');
  if v_brand = '' and btrim(coalesce(val->>'model',''))<>'' then
    raise exception 'Elegí una marca o autor antes de indicar el modelo.' using errcode='22023';
  end if;
  v_model := public.inventory_term('model',v_category,v_brand,val->>'model');
  v_type := public.inventory_term('type',v_category,'',val->>'type');
  insert into public.inventory_items(id,number,category,brand,model,manufacture_date,
    original_number,type,destination,notes,photo_path,created_by,updated_by)
    overriding system value
  values(image_row.id,slot.number,v_category,v_brand,v_model,v_date,v_original,v_type,
    v_destination,v_notes,image_row.photo_path,actor,actor)
  returning * into saved;
  update public.inventory_bulk_slots
    set image_id=image_row.id,assigned_by=actor,assigned_at=now()
    where number=slot.number;
  -- Solo se vincula el número: todavía NO se ha pegado la etiqueta.
  -- El operador confirma la colocación mediante set_inventory_label después.
  return saved;
end;
$$;
revoke all on function public.assign_inventory_bulk_image(uuid,uuid,bigint,jsonb) from public,anon;
grant execute on function public.assign_inventory_bulk_image(uuid,uuid,bigint,jsonb) to authenticated;


-- Proteger los archivos adicionales de un lote hasta su asociación y, después,
-- a través del campo extra_photos de la ficha definitiva.
alter policy members_cleanup_photos on storage.objects using (
  bucket_id='inventory-photos'
  and (select public.inventory_is_member())
  and not exists (
    select 1 from public.inventory_items i where i.photo_path=name
       or name=any(coalesce(i.extra_photos,'{}'::text[]))
  )
  and not exists (
    select 1 from public.inventory_bulk_images bi
    where (bi.photo_path=name or name=any(coalesce(bi.extra_photos,'{}'::text[])))
      and not exists(select 1 from public.inventory_bulk_slots bs where bs.image_id=bi.id)
  )
);
notify pgrst, 'reload schema';
commit;
