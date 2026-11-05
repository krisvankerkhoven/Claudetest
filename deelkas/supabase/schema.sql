-- Deelkas: uitgaven delen met vrienden, zonder accounts.
-- Toegang loopt enkel via de groepscode (een lang willekeurig geheim). Tabellen zijn niet rechtstreeks leesbaar.
-- Plak dit bestand in Supabase > SQL Editor en voer het uit.

create extension if not exists pgcrypto;

create table if not exists groups (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  name text not null check (char_length(name) between 1 and 60),
  created_at timestamptz not null default now()
);
create table if not exists members (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 30),
  created_at timestamptz not null default now()
);
create table if not exists expenses (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups(id) on delete cascade,
  descr text not null check (char_length(descr) between 1 and 80),
  amount integer not null check (amount > 0),          -- in cent
  paid_by uuid not null references members(id) on delete restrict,
  shares jsonb not null,                                -- { member_id: cent }
  date date not null,
  created_at timestamptz not null default now()
);
create table if not exists settlements (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups(id) on delete cascade,
  from_member uuid not null references members(id) on delete restrict,
  to_member uuid not null references members(id) on delete restrict,
  amount integer not null check (amount > 0),
  date date not null,
  created_at timestamptz not null default now()
);

-- Row level security aan zonder policies: anon kan niets rechtstreeks lezen of schrijven.
alter table groups enable row level security;
alter table members enable row level security;
alter table expenses enable row level security;
alter table settlements enable row level security;

create or replace function _gid(p_code text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v uuid;
begin
  select id into v from groups where code = p_code;
  if v is null then raise exception 'Onbekende groep'; end if;
  return v;
end $$;
revoke all on function _gid(text) from public, anon, authenticated;

create or replace function create_group(p_name text) returns text
language plpgsql security definer set search_path = public as $$
declare v_code text := encode(gen_random_bytes(10), 'hex');
begin
  insert into groups(code, name) values (v_code, left(trim(p_name), 60));
  return v_code;
end $$;

create or replace function get_group(p_code text) returns jsonb
language sql security definer set search_path = public stable as $$
  select jsonb_build_object(
    'name', g.name,
    'members', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name) order by m.created_at)
                         from members m where m.group_id = g.id), '[]'::jsonb),
    'expenses', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'desc', e.descr, 'amount', e.amount,
                           'paidBy', e.paid_by, 'shares', e.shares, 'date', e.date,
                           'createdAt', (extract(epoch from e.created_at) * 1000)::bigint) order by e.created_at)
                         from expenses e where e.group_id = g.id), '[]'::jsonb),
    'settlements', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'from', s.from_member, 'to', s.to_member,
                           'amount', s.amount, 'date', s.date,
                           'createdAt', (extract(epoch from s.created_at) * 1000)::bigint) order by s.created_at)
                         from settlements s where s.group_id = g.id), '[]'::jsonb)
  )
  from groups g where g.code = p_code;
$$;

create or replace function rename_group(p_code text, p_name text) returns void
language plpgsql security definer set search_path = public as $$
begin
  update groups set name = left(trim(p_name), 60) where id = _gid(p_code);
end $$;

create or replace function add_member(p_code text, p_name text) returns void
language plpgsql security definer set search_path = public as $$
declare g uuid := _gid(p_code);
begin
  if (select count(*) from members where group_id = g) >= 50 then raise exception 'Maximaal 50 leden'; end if;
  insert into members(group_id, name) values (g, left(trim(p_name), 30));
end $$;

create or replace function remove_member(p_code text, p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare g uuid := _gid(p_code);
begin
  if exists (select 1 from expenses where group_id = g and (paid_by = p_id or shares ? p_id::text))
     or exists (select 1 from settlements where group_id = g and (from_member = p_id or to_member = p_id)) then
    raise exception 'Dit lid heeft al uitgaven';
  end if;
  delete from members where id = p_id and group_id = g;
end $$;

create or replace function add_expense(p_code text, p_desc text, p_amount int, p_paid_by uuid, p_shares jsonb, p_date date)
returns void language plpgsql security definer set search_path = public as $$
declare g uuid := _gid(p_code); k text; total int := 0;
begin
  if (select count(*) from expenses where group_id = g) >= 5000 then raise exception 'Te veel uitgaven'; end if;
  if not exists (select 1 from members where id = p_paid_by and group_id = g) then raise exception 'Onbekende betaler'; end if;
  for k in select jsonb_object_keys(p_shares) loop
    if not exists (select 1 from members where id = k::uuid and group_id = g) then raise exception 'Onbekend lid in verdeling'; end if;
    total := total + (p_shares ->> k)::int;
  end loop;
  if total <> p_amount then raise exception 'Verdeling klopt niet met het bedrag'; end if;
  insert into expenses(group_id, descr, amount, paid_by, shares, date)
  values (g, left(trim(p_desc), 80), p_amount, p_paid_by, p_shares, p_date);
end $$;

create or replace function delete_expense(p_code text, p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from expenses where id = p_id and group_id = _gid(p_code);
end $$;

create or replace function add_settlement(p_code text, p_from uuid, p_to uuid, p_amount int, p_date date)
returns void language plpgsql security definer set search_path = public as $$
declare g uuid := _gid(p_code);
begin
  if p_from = p_to then raise exception 'Zelfde persoon'; end if;
  if (select count(*) from members where id in (p_from, p_to) and group_id = g) <> 2 then raise exception 'Onbekend lid'; end if;
  insert into settlements(group_id, from_member, to_member, amount, date) values (g, p_from, p_to, p_amount, p_date);
end $$;

create or replace function delete_settlement(p_code text, p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from settlements where id = p_id and group_id = _gid(p_code);
end $$;

grant execute on function create_group(text), get_group(text), rename_group(text, text), add_member(text, text),
  remove_member(text, uuid), add_expense(text, text, int, uuid, jsonb, date), delete_expense(text, uuid),
  add_settlement(text, uuid, uuid, int, date), delete_settlement(text, uuid) to anon, authenticated;
