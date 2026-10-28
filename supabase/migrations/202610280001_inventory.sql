-- Ejecutar una vez en el SQL Editor de un proyecto Supabase nuevo.
begin;

create table public.inventory_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (length(display_name) between 1 and 120)
);
alter table public.inventory_members enable row level security;
create policy own_membership on public.inventory_members for select to authenticated
  using (user_id = (select auth.uid()));
revoke all on public.inventory_members from authenticated;
grant select on public.inventory_members to authenticated;
revoke all on public.inventory_members from anon;

create function public.inventory_is_member() returns boolean
language sql stable security invoker set search_path = '' as $$
  select exists(select 1 from public.inventory_members where user_id = (select auth.uid()));
$$;
revoke all on function public.inventory_is_member() from public;
grant execute on function public.inventory_is_member() to authenticated;

create table public.inventory_terms (
  kind text not null check (kind in ('category','brand','model','type')),
  category text not null default '',
  parent_name text not null default '',
  name text not null check (length(name) between 1 and 120 and name = btrim(name)),
  category_key text generated always as (lower(btrim(category))) stored,
  parent_key text generated always as (lower(btrim(parent_name))) stored,
  name_key text generated always as (lower(btrim(name))) stored,
  unique (kind, category_key, parent_key, name_key)
);
alter table public.inventory_terms enable row level security;
create policy members_read_terms on public.inventory_terms for select to authenticated
  using ((select public.inventory_is_member()));
revoke all on public.inventory_terms from anon, authenticated;
grant select on public.inventory_terms to authenticated;

insert into public.inventory_terms(kind,name) values
  ('category','Máquina de escribir'),('category','Fotografía'),('category','Velador');
insert into public.inventory_terms(kind,category,name) values
  ('type','Máquina de escribir','Portátil'),('type','Máquina de escribir','Escritorio');

-- La secuencia es central, atómica y no recicla números de fichas retiradas.
create table public.inventory_items (
  id uuid primary key,
  number bigint generated always as identity (minvalue 1 maxvalue 999999 no cycle) unique,
  code text generated always as ('P' || lpad(number::text, 6, '0')) stored unique,
  category text not null check (length(category) between 1 and 120),
  brand text not null default '' check (length(brand) <= 120),
  model text not null default '' check (length(model) <= 120 and (model = '' or brand <> '')),
  manufacture_date text not null default '' check (length(manufacture_date) <= 80),
  type text not null default '' check (length(type) <= 120),
  destination text not null check (destination in ('museo','tienda','otros')),
  notes text not null default '' check (length(notes) <= 4000),
  photo_path text not null unique,
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id),
  updated_by uuid not null references auth.users(id)
);
alter table public.inventory_items enable row level security;
create policy members_read_items on public.inventory_items for select to authenticated
  using ((select public.inventory_is_member()));
revoke all on public.inventory_items from anon, authenticated;
grant select on public.inventory_items to authenticated;
revoke all on sequence public.inventory_items_number_seq from anon, authenticated;

create function public.inventory_term(p_kind text, p_category text, p_parent text, p_name text)
returns text language plpgsql security definer set search_path = '' as $$
declare result text;
begin
  if btrim(coalesce(p_name,'')) = '' then return ''; end if;
  insert into public.inventory_terms as t(kind,category,parent_name,name)
    values(p_kind,p_category,p_parent,btrim(p_name))
    on conflict (kind,category_key,parent_key,name_key) do update set name = t.name
    returning name into result;
  return result;
end;
$$;
-- Helper interno: nunca puede invocarse directamente desde el navegador.
revoke all on function public.inventory_term(text,text,text,text) from public, anon, authenticated;

create function public.save_inventory_item(p_id uuid, p_revision integer, p_values jsonb, p_photo_path text)
returns public.inventory_items language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  previous public.inventory_items;
  saved public.inventory_items;
  v_category text; v_brand text; v_model text; v_type text;
  v_date text := btrim(coalesce(p_values->>'manufacture_date',''));
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
  if previous.id is null or p_photo_path is distinct from previous.photo_path then
    if p_photo_path is null or p_photo_path !~ (
      '^' || actor::text || '/' || p_id::text || '/[a-f0-9]{64}\.jpg$')
      or not exists(select 1 from storage.objects where bucket_id = 'inventory-photos' and name = p_photo_path) then
      raise exception 'Subí una foto válida antes de guardar.' using errcode = '22023';
    end if;
  end if;
  if previous.id is not null and p_revision = 0 then
    -- Un alta cuya respuesta se perdió se puede repetir sin duplicar el objeto.
    if previous.created_by = actor and previous.revision = 1
      and (previous.category,previous.brand,previous.model,previous.manufacture_date,previous.type,previous.destination,previous.notes,previous.photo_path)
      is not distinct from (v_category,v_brand,v_model,v_date,v_type,v_destination,v_notes,p_photo_path) then
      return previous;
    end if;
    raise exception 'Esta ficha ya fue guardada. Actualizá el inventario antes de continuar.' using errcode = '40001';
  end if;
  if previous.id is null then
    insert into public.inventory_items(id,category,brand,model,manufacture_date,type,destination,notes,photo_path,created_by,updated_by)
      values(p_id,v_category,v_brand,v_model,v_date,v_type,v_destination,v_notes,p_photo_path,actor,actor)
      returning * into saved;
  else
    update public.inventory_items set category=v_category, brand=v_brand, model=v_model,
      manufacture_date=v_date, type=v_type, destination=v_destination, notes=v_notes,
      photo_path=p_photo_path, revision=revision+1, updated_at=now(), updated_by=actor
      where id=p_id returning * into saved;
  end if;
  return saved;
end;
$$;
revoke all on function public.save_inventory_item(uuid,integer,jsonb,text) from public, anon;
grant execute on function public.save_inventory_item(uuid,integer,jsonb,text) to authenticated;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('inventory-photos','inventory-photos',false,153600,array['image/jpeg']);

create policy members_read_photos on storage.objects for select to authenticated
using (bucket_id = 'inventory-photos' and (select public.inventory_is_member()));
create policy members_upload_photos on storage.objects for insert to authenticated
with check (bucket_id = 'inventory-photos' and (select public.inventory_is_member())
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and name ~ '^[a-f0-9-]{36}/[a-f0-9-]{36}/[a-f0-9]{64}\.jpg$');
-- Solo se pueden limpiar archivos no vinculados a una ficha; nunca pisar una foto.
create policy members_cleanup_photos on storage.objects for delete to authenticated
using (bucket_id = 'inventory-photos' and (select public.inventory_is_member())
  and not exists(select 1 from public.inventory_items i where i.photo_path = name));
commit;
