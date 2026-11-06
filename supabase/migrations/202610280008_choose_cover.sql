-- Ejecutar después de 202610280007_extra_photos.sql.
begin;

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
    insert into public.inventory_items(id,category,brand,model,manufacture_date,original_number,type,destination,notes,photo_path,photo_crop,extra_photos,created_by,updated_by)
      values(p_id,v_category,v_brand,v_model,v_date,v_original_number,v_type,v_destination,v_notes,p_photo_path,v_crop,v_extra_photos,actor,actor)
      returning * into saved;
  else
    update public.inventory_items set category=v_category, brand=v_brand, model=v_model,
      manufacture_date=v_date, original_number=v_original_number, type=v_type, destination=v_destination, notes=v_notes,
      photo_path=p_photo_path, photo_crop=v_crop, extra_photos=v_extra_photos, revision=revision+1, updated_at=now(), updated_by=actor
      where id=p_id returning * into saved;
  end if;
  return saved;
end;
$$;
revoke all on function public.save_inventory_item(uuid,integer,jsonb,text) from public, anon;
grant execute on function public.save_inventory_item(uuid,integer,jsonb,text) to authenticated;

notify pgrst, 'reload schema';
commit;
