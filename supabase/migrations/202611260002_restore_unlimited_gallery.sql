begin;

alter table public.inventory_items
  drop constraint if exists inventory_items_extra_photos_check;

do $$
declare
  definition text := pg_get_functiondef('public.save_inventory_item(uuid,integer,jsonb,text)'::regprocedure);
  limited text := $body$    if jsonb_array_length(p_values->'extra_photos') > 7 then
      raise exception 'Se admiten hasta siete fotos adicionales.' using errcode = '22023';
    end if;
$body$;
  repaired text;
begin
  repaired := replace(definition, limited, '');
  if strpos(repaired, 'Se admiten hasta siete fotos adicionales.') > 0 then
    raise exception 'La validación de la galería difiere de la versión esperada.';
  end if;
  if repaired is distinct from definition then
    execute repaired;
  end if;
end;
$$;

commit;
