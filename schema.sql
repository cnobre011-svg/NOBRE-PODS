-- Loja Adega — esquema do banco (PostgreSQL / Supabase)
-- Rode no Supabase: SQL Editor > New query > cole tudo > Run.

create table if not exists public.admins (
  id bigint generated always as identity primary key,
  username text not null unique,
  pass text not null,                       -- hash scrypt (nunca a senha)
  totp_secret text,
  totp_on boolean not null default false,
  totp_last bigint not null default 0
);
create table if not exists public.sessions (
  hash text primary key,                    -- hash SHA-256 do token do cookie
  admin_id bigint not null references public.admins(id) on delete cascade,
  exp bigint not null
);
create table if not exists public.categories (id text primary key, data jsonb not null);
create table if not exists public.products   (id text primary key, data jsonb not null);
create table if not exists public.settings   (k text primary key, v jsonb not null);
create table if not exists public.orders (
  num bigint generated always as identity primary key,
  token text not null,
  status text not null default 'reserved',
  created timestamptz not null default now(),
  data jsonb not null default '{}'::jsonb
);
create table if not exists public.audit (
  id bigint generated always as identity primary key,
  ts timestamptz not null default now(),
  admin text not null,
  action text not null,
  detail text not null default ''
);
create table if not exists public.login_attempts (key text not null, ts bigint not null);
create index if not exists login_attempts_idx on public.login_attempts (key, ts);
create index if not exists orders_status_idx on public.orders (status, num desc);

-- ===== GRANTs explícitos =====
-- Desde 30/05/2026 (projetos novos) e 30/10/2026 (todos), tabelas novas em "public" NÃO ficam expostas
-- à API automaticamente: sem GRANT dá erro 42501 "permission denied", inclusive para a service_role.
grant usage on schema public to anon, authenticated, service_role;
grant select, insert, update, delete on
  public.admins, public.sessions, public.categories, public.products,
  public.settings, public.orders, public.audit, public.login_attempts
  to service_role;
grant usage, select on all sequences in schema public to service_role;
-- Leitura pública só do catálogo (o RLS abaixo ainda filtra as linhas)
grant select on public.categories, public.products, public.settings to anon, authenticated;

-- ===== RLS: ligado em TODAS as tabelas =====
alter table public.admins          enable row level security;
alter table public.sessions        enable row level security;
alter table public.categories      enable row level security;
alter table public.products        enable row level security;
alter table public.settings        enable row level security;
alter table public.orders          enable row level security;
alter table public.audit           enable row level security;
alter table public.login_attempts  enable row level security;

-- Tabelas sensíveis: nenhuma política = nenhum acesso pelas chaves públicas (anon/authenticated).
-- Só o servidor, com a chave service_role, lê e grava nelas.
revoke all on public.admins, public.sessions, public.orders, public.audit, public.login_attempts from anon, authenticated;

-- Catálogo: o público só pode LER (necessário para o Realtime avisar os visitantes). Ninguém grava por aqui.
revoke insert, update, delete on public.categories, public.products, public.settings from anon, authenticated;
drop policy if exists "leitura publica categorias" on public.categories;
drop policy if exists "leitura publica produtos"   on public.products;
drop policy if exists "leitura publica config"     on public.settings;
create policy "leitura publica categorias" on public.categories for select to anon, authenticated using (true);
create policy "leitura publica produtos"   on public.products   for select to anon, authenticated using ((data->>'active') is distinct from 'false');
create policy "leitura publica config"     on public.settings   for select to anon, authenticated using (true);

-- ===== Realtime: avisa os visitantes quando o catálogo muda =====
do $$ begin
  begin alter publication supabase_realtime add table public.products;   exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.categories; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.settings;   exception when duplicate_object then null; end;
end $$;

-- ===== Storage: bucket público só para LEITURA das fotos (upload apenas pelo servidor) =====
insert into storage.buckets (id, name, public) values ('produtos', 'produtos', true) on conflict (id) do nothing;
