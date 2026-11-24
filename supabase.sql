-- Rode este arquivo uma vez no Supabase: SQL Editor > New query > colar > Run.

create table if not exists public.lancamentos (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  tipo text not null check (tipo in ('receber', 'pagar')),
  mes text not null,
  v jsonb not null default '{}'::jsonb,
  ordem bigint not null default 0
);
create index if not exists lancamentos_user_mes on public.lancamentos (user_id, mes);

create table if not exists public.config (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  chave text not null,
  valor jsonb not null,
  primary key (user_id, chave)
);

-- Cada pessoa enxerga e altera somente os próprios dados.
alter table public.lancamentos enable row level security;
alter table public.config enable row level security;

drop policy if exists "lancamentos_dono" on public.lancamentos;
create policy "lancamentos_dono" on public.lancamentos
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "config_dono" on public.config;
create policy "config_dono" on public.config
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
