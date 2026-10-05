-- All application access goes through the authenticated maestro-api function.
-- Browser keys cannot read tables or the private file bucket directly.
create table public.maestro_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null check (length(name) between 1 and 100),
  email text not null,
  role text not null check (role in ('admin','editor','viewer')),
  active boolean not null default true,
  invalid_before bigint not null default 0
);
create table public.maestro_packages (
  id uuid primary key default gen_random_uuid(), data jsonb not null
);
create table public.maestro_sponsors (
  id uuid primary key default gen_random_uuid(), data jsonb not null,
  package_id uuid references public.maestro_packages(id) on delete restrict,
  revision integer not null default 1,
  updated_at timestamptz not null default now()
);
create table public.maestro_attachments (
  id uuid primary key default gen_random_uuid(),
  sponsor_id uuid not null references public.maestro_sponsors(id) on delete cascade,
  kind text not null check (kind in ('approval','purchase-order','logo')),
  name text not null, mime text not null, size integer not null check(size between 1 and 10485760),
  path text not null unique, created_at timestamptz not null default now()
);
create unique index maestro_one_sponsor_logo on public.maestro_attachments(sponsor_id) where kind='logo';
create index maestro_attachment_owner on public.maestro_attachments(sponsor_id);
create table public.maestro_settings (id text primary key, data jsonb not null);
insert into public.maestro_settings values ('brand','{"organization":"MAESTRO","accent":"#536b62","configured":false}');

alter table public.maestro_profiles enable row level security;
alter table public.maestro_packages enable row level security;
alter table public.maestro_sponsors enable row level security;
alter table public.maestro_attachments enable row level security;
alter table public.maestro_settings enable row level security;
revoke all on public.maestro_profiles,public.maestro_packages,public.maestro_sponsors,public.maestro_attachments,public.maestro_settings from anon,authenticated;
grant all on public.maestro_profiles,public.maestro_packages,public.maestro_sponsors,public.maestro_attachments,public.maestro_settings to service_role;

create function public.maestro_touch_sponsor(sponsor uuid) returns void
language sql set search_path = '' as $$
  update public.maestro_sponsors set revision=revision+1, updated_at=now() where id=sponsor;
$$;
revoke all on function public.maestro_touch_sponsor(uuid) from public,anon,authenticated;
grant execute on function public.maestro_touch_sponsor(uuid) to service_role;

create function public.maestro_session_is_current(account uuid, session uuid) returns boolean
language sql security definer set search_path = '' as $$
  select exists(select 1 from auth.sessions where id=session and user_id=account);
$$;
create function public.maestro_revoke_sessions(account uuid) returns void
language sql security definer set search_path = '' as $$
  delete from auth.sessions where user_id=account;
$$;
revoke all on function public.maestro_session_is_current(uuid,uuid), public.maestro_revoke_sessions(uuid) from public,anon,authenticated;
grant execute on function public.maestro_session_is_current(uuid,uuid), public.maestro_revoke_sessions(uuid) to service_role;

-- Run once in the project's SQL editor, after creating your own confirmed
-- Auth user in the dashboard. No registration or automatic admin promotion.
create function public.maestro_bootstrap_admin(account_email text, display_name text) returns void
language plpgsql security definer set search_path = '' as $$
declare account uuid;
begin
  lock table public.maestro_profiles in exclusive mode;
  if exists(select 1 from public.maestro_profiles) then
    raise exception 'The workspace administrator is already configured.';
  end if;
  select id into account from auth.users where lower(email)=lower(account_email) and email_confirmed_at is not null;
  if account is null then raise exception 'Create and confirm your Auth user first.'; end if;
  insert into public.maestro_profiles(id,name,email,role) values(account,display_name,account_email,'admin');
end;
$$;
revoke all on function public.maestro_bootstrap_admin(text,text) from public,anon,authenticated;
grant execute on function public.maestro_bootstrap_admin(text,text) to service_role;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('maestro-files','maestro-files',false,10485760,array['image/png','image/jpeg','image/webp','application/pdf']);
-- Deliberately no storage policies: authenticated API alone issues signed links.
