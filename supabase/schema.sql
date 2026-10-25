-- =====================================================================
-- One Life — esquema de base de datos para Supabase
--
-- Cómo usarlo:
--   Supabase → SQL Editor → New query → pega TODO este archivo → Run
--
-- Es seguro ejecutarlo más de una vez: usa IF NOT EXISTS / OR REPLACE
-- y borra las políticas antes de volver a crearlas.
--
-- Secciones:
--   1. Tablas
--   2. Funciones auxiliares (¿es admin?, crear perfil al registrarse...)
--   3. Seguridad por fila (RLS): cada usuario ve lo suyo, el admin todo
--   4. Métricas para el panel de administrador
--   5. Permisos
--   6. Convertir tu cuenta en administrador (al final, comentado)
-- =====================================================================


-- =====================================================================
-- 1. TABLAS
-- =====================================================================

-- Perfil de cada persona. El correo y la contraseña los guarda Supabase
-- Auth en auth.users; aquí solo va lo que One Life necesita.
create table if not exists public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  name          text not null check (char_length(name) between 2 and 40),
  role          text not null default 'user' check (role in ('user', 'admin')),
  age           int check (age between 2 and 120),
  sex           text check (sex in ('m', 'f', 'x')),
  height_cm     numeric(5,1) check (height_cm between 50 and 250),
  weight_kg     numeric(5,1) check (weight_kg between 20 and 350),
  goal          text not null default 'mantener' check (goal in ('perder', 'mantener', 'ganar')),
  target_kg     numeric(5,1) check (target_kg between 20 and 350),
  level         text not null default 'ligero' check (level in ('sedentario', 'ligero', 'moderado', 'intenso')),
  minutes_goal  int not null default 30 check (minutes_goal between 10 and 300),
  notifications jsonb not null default '{"weighIn": true, "activity": true, "tips": true, "security": true}',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Historial de peso. El IMC lo calcula la base de datos sola
-- (columna generada), así nunca queda desincronizado.
create table if not exists public.weight_records (
  id         bigint generated always as identity primary key,
  user_id    uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  date       date not null default current_date,
  weight_kg  numeric(5,1) not null check (weight_kg between 20 and 350),
  height_cm  numeric(5,1) not null check (height_cm between 50 and 250),
  bmi        numeric(4,1) generated always as (round(weight_kg / ((height_cm / 100) ^ 2), 1)) stored,
  created_at timestamptz not null default now(),
  unique (user_id, date)  -- un registro por persona y por día
);

-- Actividad física.
create table if not exists public.activities (
  id         bigint generated always as identity primary key,
  user_id    uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  date       date not null default current_date,
  type       text not null check (type in ('caminata', 'correr', 'ciclismo', 'natacion', 'fuerza', 'yoga', 'hiit', 'baile')),
  minutes    int not null check (minutes between 1 and 600),
  steps      int not null default 0 check (steps between 0 and 100000),
  kcal       int not null default 0 check (kcal >= 0),
  created_at timestamptz not null default now()
);

-- Cada inicio de sesión exitoso (para "cuántos han iniciado sesión").
create table if not exists public.login_events (
  id         bigint generated always as identity primary key,
  user_id    uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  user_agent text,
  created_at timestamptz not null default now()
);

-- Índices: aceleran las consultas por usuario y fecha.
create index if not exists weight_records_user_date_idx on public.weight_records (user_id, date desc);
create index if not exists activities_user_date_idx     on public.activities (user_id, date desc);
create index if not exists login_events_created_idx     on public.login_events (created_at desc);
create index if not exists login_events_user_idx        on public.login_events (user_id);


-- =====================================================================
-- 2. FUNCIONES AUXILIARES
-- =====================================================================

-- ¿La persona que hace la consulta es administradora?
-- "security definer" hace que la función lea profiles sin pasar por RLS.
-- Sin esto, una política de profiles que consulte profiles entraría en
-- un bucle infinito ("infinite recursion detected in policy").
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

-- Crea el perfil automáticamente cuando alguien se registra.
-- El nombre llega desde la app en options.data.name al hacer signUp.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text := trim(coalesce(new.raw_user_meta_data ->> 'name', ''));
begin
  if char_length(v_name) < 2 then
    v_name := 'Usuario';
  end if;
  insert into public.profiles (id, name)
  values (new.id, left(v_name, 40))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Impide que un usuario normal se cambie a sí mismo el rol a 'admin'.
-- Desde el SQL Editor (sin sesión de usuario, auth.uid() es null) sí se
-- permite: así es como creas al primer administrador.
create or replace function public.protect_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role is distinct from old.role
     and auth.uid() is not null
     and not public.is_admin() then
    raise exception 'Solo un administrador puede cambiar roles'
      using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists protect_profile on public.profiles;
create trigger protect_profile
  before update on public.profiles
  for each row execute function public.protect_profile();


-- =====================================================================
-- 3. SEGURIDAD POR FILA (RLS)
--    Regla general: cada usuario ve y edita solo sus filas;
--    el administrador puede verlas todas.
--    Sin una política que lo permita, la consulta devuelve 0 filas.
-- =====================================================================

alter table public.profiles       enable row level security;
alter table public.weight_records enable row level security;
alter table public.activities     enable row level security;
alter table public.login_events   enable row level security;

-- ---------- profiles ----------
-- (No hay política de INSERT: el perfil lo crea el trigger handle_new_user.)
drop policy if exists "profiles: ver propio o admin" on public.profiles;
create policy "profiles: ver propio o admin" on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) or public.is_admin());

drop policy if exists "profiles: editar propio o admin" on public.profiles;
create policy "profiles: editar propio o admin" on public.profiles
  for update to authenticated
  using (id = (select auth.uid()) or public.is_admin())
  with check (id = (select auth.uid()) or public.is_admin());

-- ---------- weight_records ----------
drop policy if exists "peso: ver propio o admin" on public.weight_records;
create policy "peso: ver propio o admin" on public.weight_records
  for select to authenticated
  using (user_id = (select auth.uid()) or public.is_admin());

drop policy if exists "peso: crear propio" on public.weight_records;
create policy "peso: crear propio" on public.weight_records
  for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "peso: editar propio" on public.weight_records;
create policy "peso: editar propio" on public.weight_records
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "peso: borrar propio o admin" on public.weight_records;
create policy "peso: borrar propio o admin" on public.weight_records
  for delete to authenticated
  using (user_id = (select auth.uid()) or public.is_admin());

-- ---------- activities ----------
drop policy if exists "actividad: ver propia o admin" on public.activities;
create policy "actividad: ver propia o admin" on public.activities
  for select to authenticated
  using (user_id = (select auth.uid()) or public.is_admin());

drop policy if exists "actividad: crear propia" on public.activities;
create policy "actividad: crear propia" on public.activities
  for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "actividad: borrar propia o admin" on public.activities;
create policy "actividad: borrar propia o admin" on public.activities
  for delete to authenticated
  using (user_id = (select auth.uid()) or public.is_admin());

-- ---------- login_events ----------
drop policy if exists "accesos: registrar propio" on public.login_events;
create policy "accesos: registrar propio" on public.login_events
  for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "accesos: ver propios o admin" on public.login_events;
create policy "accesos: ver propios o admin" on public.login_events
  for select to authenticated
  using (user_id = (select auth.uid()) or public.is_admin());


-- =====================================================================
-- 4. MÉTRICAS PARA EL PANEL DE ADMINISTRADOR
--    Son funciones (no vistas) porque una vista normal ignora RLS y
--    cualquiera podría leerla. Cada función comprueba primero que
--    quien la llama sea admin; si no, lanza "Acceso denegado".
--    Desde la app se llaman con: supabase.rpc('admin_metrics')
-- =====================================================================

-- Último peso registrado de cada persona.
-- security_invoker = true: la vista respeta las políticas RLS de quien
-- la consulta (un usuario solo ve su fila; el admin ve todas).
create or replace view public.latest_weights
with (security_invoker = true) as
select distinct on (user_id)
  user_id, date, weight_kg, height_cm, bmi
from public.weight_records
order by user_id, date desc;

-- Resumen general: totales y promedios.
create or replace function public.admin_metrics()
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result json;
begin
  if not public.is_admin() then
    raise exception 'Acceso denegado' using errcode = '42501';
  end if;

  select json_build_object(
    'usuarios',                (select count(*) from profiles),
    'nuevos_30_dias',          (select count(*) from profiles where created_at > now() - interval '30 days'),
    'activos_7_dias',          (select count(distinct user_id) from login_events where created_at > now() - interval '7 days'),
    'inicios_sesion_total',    (select count(*) from login_events),
    'inicios_sesion_hoy',      (select count(*) from login_events where created_at >= current_date),
    'con_registro_de_peso',    (select count(*) from latest_weights),
    'peso_promedio',           (select round(avg(weight_kg), 1) from latest_weights),
    'imc_promedio',            (select round(avg(bmi), 1) from latest_weights),
    'edad_promedio',           (select round(avg(age), 1) from profiles where age is not null),
    'minutos_promedio_semana', (select round(avg(total), 0) from (
                                  select sum(minutes) as total
                                  from activities
                                  where date > current_date - 7
                                  group by user_id) t)
  ) into result;

  return result;
end;
$$;

-- Cuántas personas hay en cada categoría de IMC (según su último peso).
create or replace function public.admin_bmi_distribution()
returns table (categoria text, orden int, usuarios bigint)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Acceso denegado' using errcode = '42501';
  end if;

  return query
  with cats(categoria, orden, minimo, maximo) as (
    values ('Bajo peso', 1, 0::numeric, 18.5::numeric),
           ('Peso normal', 2, 18.5, 25),
           ('Sobrepeso', 3, 25, 30),
           ('Obesidad I', 4, 30, 35),
           ('Obesidad II', 5, 35, 40),
           ('Obesidad III', 6, 40, 1000)
  )
  select c.categoria, c.orden, count(w.user_id)
  from cats c
  left join latest_weights w on w.bmi >= c.minimo and w.bmi < c.maximo
  group by c.categoria, c.orden
  order by c.orden;
end;
$$;

-- Inicios de sesión por día (rellena con 0 los días sin accesos).
create or replace function public.admin_logins_per_day(dias int default 30)
returns table (dia date, inicios bigint, usuarios bigint)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Acceso denegado' using errcode = '42501';
  end if;

  return query
  select d::date,
         count(e.id),
         count(distinct e.user_id)
  from generate_series(current_date - (least(greatest(dias, 1), 365) - 1), current_date, interval '1 day') d
  left join login_events e on e.created_at::date = d::date
  group by d
  order by d;
end;
$$;

-- Lista de usuarios para la tabla del panel (incluye el correo, que
-- vive en auth.users y no es accesible desde la app de otra forma).
create or replace function public.admin_list_users()
returns table (
  id              uuid,
  name            text,
  email           text,
  role            text,
  created_at      timestamptz,
  last_sign_in_at timestamptz,
  weight_kg       numeric,
  bmi             numeric,
  logins          bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Acceso denegado' using errcode = '42501';
  end if;

  return query
  select p.id, p.name, u.email::text, p.role, p.created_at, u.last_sign_in_at,
         w.weight_kg, w.bmi,
         (select count(*) from login_events e where e.user_id = p.id)
  from profiles p
  join auth.users u on u.id = p.id
  left join latest_weights w on w.user_id = p.id
  order by p.created_at desc;
end;
$$;


-- =====================================================================
-- 5. PERMISOS
--    Las funciones solo pueden llamarlas usuarios con sesión iniciada.
--    (Igual comprueban por dentro que sean admin.)
-- =====================================================================

revoke execute on function public.is_admin()                  from public, anon;
revoke execute on function public.admin_metrics()             from public, anon;
revoke execute on function public.admin_bmi_distribution()    from public, anon;
revoke execute on function public.admin_logins_per_day(int)   from public, anon;
revoke execute on function public.admin_list_users()          from public, anon;
revoke execute on function public.handle_new_user()           from public, anon, authenticated;
revoke execute on function public.protect_profile()           from public, anon, authenticated;

grant execute on function public.is_admin()                   to authenticated;
grant execute on function public.admin_metrics()              to authenticated;
grant execute on function public.admin_bmi_distribution()     to authenticated;
grant execute on function public.admin_logins_per_day(int)    to authenticated;
grant execute on function public.admin_list_users()           to authenticated;

grant select on public.latest_weights to authenticated;


-- =====================================================================
-- 6. CONVERTIR TU CUENTA EN ADMINISTRADOR
--    1) Regístrate primero en la app con tu correo.
--    2) Cambia el correo de abajo, quita los dos guiones "--" del
--       principio de la línea y ejecuta SOLO esa línea.
-- =====================================================================

-- update public.profiles set role = 'admin' where id = (select id from auth.users where email = 'TU_CORREO@ejemplo.com');
