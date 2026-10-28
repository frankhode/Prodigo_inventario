-- Ejecutar UNA VEZ después de las migraciones 001 y 002.
-- Al terminar devuelve los dos enlaces de alta para compartir de forma individual.
begin;
create table public.inventory_invites (
  username text primary key check (username in ('aleProdigo','maxiProdigo')),
  display_name text not null,
  token_hash text not null unique,
  expires_at timestamptz not null default now() + interval '30 days',
  used_at timestamptz,
  used_by uuid unique references auth.users(id) on delete restrict deferrable initially deferred
);
alter table public.inventory_invites enable row level security;
revoke all on public.inventory_invites from public, anon, authenticated, service_role;

create function public.create_inventory_invite(p_username text)
returns table(username text, invitation_code text)
language plpgsql security definer set search_path = '' as $$
declare canonical text; code text;
begin
  canonical := case lower(btrim(p_username)) when 'aleprodigo' then 'aleProdigo' when 'maxiprodigo' then 'maxiProdigo' end;
  if canonical is null then raise exception 'Nombre no disponible para altas.'; end if;
  if exists(select 1 from public.inventory_members m where m.username_key = lower(canonical)) then
    raise exception 'Esta persona ya tiene una cuenta habilitada.';
  end if;
  code := replace(gen_random_uuid()::text,'-','');
  insert into public.inventory_invites as i(username,display_name,token_hash)
    values(canonical,case canonical when 'aleProdigo' then 'Ale' else 'Maxi' end,encode(sha256(convert_to(code,'UTF8')),'hex'))
    on conflict on constraint inventory_invites_pkey do update set token_hash=excluded.token_hash, expires_at=now()+interval '30 days'
    where i.used_at is null;
  if not found then raise exception 'La invitación ya fue utilizada.'; end if;
  return query select canonical,code;
end;
$$;
-- Solo el propietario desde SQL Editor puede generar/regenerar invitaciones.
revoke all on function public.create_inventory_invite(text) from public, anon, authenticated, service_role;

create function public.inventory_require_invite()
returns trigger language plpgsql security definer set search_path = '' as $$
declare invitation public.inventory_invites;
  metadata jsonb := coalesce(new.raw_user_meta_data,'{}'::jsonb);
  code text := metadata->>'inventory_invite';
begin
  if code is null or code !~ '^[a-f0-9]{32}$' then
    raise exception 'Se requiere una invitación válida para crear la cuenta.' using errcode='42501';
  end if;
  select * into invitation from public.inventory_invites i
    where lower(i.username) = lower(metadata->>'username')
      and i.token_hash = encode(sha256(convert_to(code,'UTF8')),'hex') for update;
  if invitation.username is null or invitation.used_at is not null or invitation.expires_at < now() then
    raise exception 'La invitación no está disponible.' using errcode='42501';
  end if;
  update public.inventory_invites set used_at=now(),used_by=new.id where username=invitation.username;
  -- No guardar el código de invitación en el perfil ni devolverlo en la sesión.
  new.raw_user_meta_data := (metadata - 'inventory_invite') || jsonb_build_object('username',invitation.username);
  return new;
end;
$$;
revoke all on function public.inventory_require_invite() from public, anon, authenticated, service_role;

create function public.inventory_enroll_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare invitation public.inventory_invites;
begin
  select * into invitation from public.inventory_invites where used_by=new.id;
  if invitation.username is null then raise exception 'La cuenta no tiene invitación.' using errcode='42501'; end if;
  insert into public.inventory_members(user_id,display_name,username)
    values(new.id,invitation.display_name,invitation.username);
  return new;
end;
$$;
revoke all on function public.inventory_enroll_user() from public, anon, authenticated, service_role;

-- Las validaciones y la membresía ocurren en la misma transacción de Supabase Auth.
-- Si falla el alta, también se revierte el consumo de la invitación.
create trigger inventory_require_invite before insert on auth.users
  for each row execute function public.inventory_require_invite();
create trigger inventory_enroll_user after insert on auth.users
  for each row execute function public.inventory_enroll_user();
commit;

-- Estos códigos se generan en el proyecto; nunca se guardan en el repositorio.
select i.username,
  'https://frankhode.github.io/Prodigo_inventario/#alta=' || i.username || '&codigo=' || i.invitation_code as enlace_de_alta
from public.create_inventory_invite('aleProdigo') i
union all
select i.username,
  'https://frankhode.github.io/Prodigo_inventario/#alta=' || i.username || '&codigo=' || i.invitation_code
from public.create_inventory_invite('maxiProdigo') i;
