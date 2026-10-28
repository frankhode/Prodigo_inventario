-- Ejecutar UNA VEZ, después de 202610280001_inventory.sql.
begin;
alter table public.inventory_members
  add column username text check (username ~ '^[A-Za-z][A-Za-z0-9_]{2,31}$'),
  add column username_key text generated always as (lower(username)) stored;
create unique index inventory_members_username_key on public.inventory_members(username_key);

-- La tabla conserva su RLS: cada integrante solo puede leer su propia membresía.
-- La función de acceso resuelve el nombre desde el servidor, nunca desde el navegador.
grant select on public.inventory_members to service_role;
update public.inventory_members set username = 'franProdigo'
where user_id = '17870e18-1350-4a2f-977d-eefb9f483261';
commit;
