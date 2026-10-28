-- Ejecutar una vez en SQL Editor. Agrega el borrado sin modificar las fichas existentes.
begin;

create or replace function public.delete_inventory_item(p_id uuid, p_revision integer)
returns text language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  previous public.inventory_items;
begin
  if actor is null or not public.inventory_is_member() then
    raise exception 'No tenés acceso a este inventario.' using errcode = '42501';
  end if;
  if p_id is null or p_revision is null or p_revision < 1 then
    raise exception 'Identificador o revisión inválidos.' using errcode = '22023';
  end if;
  -- Comparte el bloqueo del guardado: borrar no puede pisar una edición más reciente.
  perform pg_advisory_xact_lock(hashtextextended(p_id::text,0));
  select * into previous from public.inventory_items where id = p_id for update;
  -- Reintentar un borrado cuya respuesta se perdió también es seguro.
  if previous.id is null then return null; end if;
  if previous.revision <> p_revision then
    raise exception 'Otra persona modificó esta ficha. Cerrala y actualizá el inventario antes de borrarla.' using errcode = '40001';
  end if;
  delete from public.inventory_items where id = p_id;
  -- La app limpia el archivo mediante Storage una vez confirmada esta transacción.
  -- La secuencia de identificadores no se modifica ni reutiliza números.
  return previous.photo_path;
end;
$$;
revoke all on function public.delete_inventory_item(uuid,integer) from public, anon;
grant execute on function public.delete_inventory_item(uuid,integer) to authenticated;

commit;
