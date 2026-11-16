-- Etiquetado físico y conservación del historial de inventarios anulados.
-- Ejecutar DESPUÉS de 202610280008_choose_cover.sql.
begin;

alter table public.inventory_items
  add column if not exists label_confirmed_at timestamptz,
  add column if not exists label_confirmed_by uuid references auth.users(id);

alter table public.inventory_items
  add constraint inventory_label_confirmation_pair
  check ((label_confirmed_at is null) = (label_confirmed_by is null));

create table public.inventory_label_events (
  id bigint generated always as identity primary key,
  item_id uuid not null,
  inventory_number bigint not null,
  labeled boolean not null,
  changed_by uuid not null references auth.users(id),
  changed_at timestamptz not null default now()
);
create index inventory_label_events_item_idx on public.inventory_label_events(item_id,changed_at);
alter table public.inventory_label_events enable row level security;
create policy members_read_label_events on public.inventory_label_events
  for select to authenticated using ((select public.inventory_is_member()));
revoke all on public.inventory_label_events from public,anon,authenticated;
grant select on public.inventory_label_events to authenticated;
revoke all on sequence public.inventory_label_events_id_seq from public,anon,authenticated;

create table public.inventory_number_voids (
  number bigint primary key,
  code text generated always as ('P' || lpad(number::text,6,'0')) stored unique,
  item_id uuid not null unique,
  snapshot jsonb not null,
  reason text not null check (length(reason) between 3 and 300),
  voided_by uuid not null references auth.users(id),
  voided_at timestamptz not null default now()
);
alter table public.inventory_number_voids enable row level security;
create policy members_read_voids on public.inventory_number_voids
  for select to authenticated using ((select public.inventory_is_member()));
revoke all on public.inventory_number_voids from public,anon,authenticated;
grant select on public.inventory_number_voids to authenticated;

create or replace function public.set_inventory_label(
  p_id uuid, p_revision integer, p_labeled boolean
) returns public.inventory_items
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  previous public.inventory_items;
  saved public.inventory_items;
begin
  if actor is null or not public.inventory_is_member() then
    raise exception 'No tenés acceso a este inventario.' using errcode = '42501';
  end if;
  if p_id is null or p_revision is null or p_revision < 1 or p_labeled is null then
    raise exception 'Datos de etiquetado inválidos.' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_id::text,0));
  select * into previous from public.inventory_items where id = p_id for update;
  if previous.id is null then
    raise exception 'La ficha ya no está disponible.' using errcode = '40001';
  end if;
  if previous.revision <> p_revision then
    raise exception 'Otra persona modificó esta ficha. Actualizá antes de confirmar la etiqueta.' using errcode = '40001';
  end if;
  if (previous.label_confirmed_at is not null) = p_labeled then
    return previous;
  end if;
  update public.inventory_items
  set label_confirmed_at = case when p_labeled then now() else null end,
      label_confirmed_by = case when p_labeled then actor else null end,
      updated_at = now(), updated_by = actor, revision = revision + 1
  where id = p_id returning * into saved;
  insert into public.inventory_label_events(item_id,inventory_number,labeled,changed_by)
  values (saved.id,saved.number,p_labeled,actor);
  return saved;
end;
$$;
revoke all on function public.set_inventory_label(uuid,integer,boolean) from public,anon;
grant execute on function public.set_inventory_label(uuid,integer,boolean) to authenticated;

-- La anulación no recicla el correlativo. El registro histórico subsiste
-- aunque la ficha y sus archivos se retiren del catálogo.
create or replace function public.void_inventory_item(
  p_id uuid, p_revision integer, p_reason text
) returns text
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  previous public.inventory_items;
  reason_text text := btrim(coalesce(p_reason,''));
begin
  if actor is null or not public.inventory_is_member() then
    raise exception 'No tenés acceso a este inventario.' using errcode = '42501';
  end if;
  if p_id is null or p_revision is null or p_revision < 1 then
    raise exception 'Identificador o revisión inválidos.' using errcode = '22023';
  end if;
  if length(reason_text) < 3 or length(reason_text) > 300 then
    raise exception 'Explicá el motivo de anulación (3 a 300 caracteres).' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_id::text,0));
  select * into previous from public.inventory_items where id = p_id for update;
  if previous.id is null then return null; end if;
  if previous.revision <> p_revision then
    raise exception 'Otra persona modificó esta ficha. Cerrala y actualizá el inventario antes de anularla.' using errcode = '40001';
  end if;
  insert into public.inventory_number_voids(number,item_id,snapshot,reason,voided_by)
  values(previous.number,previous.id,to_jsonb(previous),reason_text,actor);
  delete from public.inventory_items where id = p_id;
  return previous.photo_path;
end;
$$;
revoke all on function public.void_inventory_item(uuid,integer,text) from public,anon;
grant execute on function public.void_inventory_item(uuid,integer,text) to authenticated;

-- Compatibilidad con clientes anteriores: también registran una anulación.
create or replace function public.delete_inventory_item(p_id uuid,p_revision integer)
returns text language plpgsql security definer set search_path = '' as $$
begin
  return public.void_inventory_item(p_id,p_revision,'Anulación desde una versión anterior');
end;
$$;
revoke all on function public.delete_inventory_item(uuid,integer) from public,anon;
grant execute on function public.delete_inventory_item(uuid,integer) to authenticated;

commit;
