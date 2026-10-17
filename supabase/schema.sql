-- Sprite Post: база данных. Выполняется один раз в Supabase: SQL Editor -> New query -> Run.
-- Скрипт можно запускать повторно, ничего не сломается.

-- ============ 1. Таблицы ============

create table if not exists public.profiles (
  id             uuid primary key references auth.users(id) on delete cascade,
  name           text not null check (char_length(name) between 1 and 40),
  role           text check (role in ('developer', 'artist')),
  requested_role text not null default 'artist' check (requested_role in ('developer', 'artist')),
  approved       boolean not null default false,
  created_at     timestamptz not null default now()
);

create table if not exists public.files (
  id          uuid primary key default gen_random_uuid(),
  uploader    uuid default auth.uid() references public.profiles(id) on delete set null,
  name        text not null check (char_length(name) between 1 and 120),
  mime        text,
  size        bigint not null check (size > 0),
  path        text not null unique,
  note        text check (note is null or char_length(note) <= 140),
  via_message boolean not null default false,
  created_at  timestamptz not null default now()
);

create table if not exists public.messages (
  id         uuid primary key default gen_random_uuid(),
  author     uuid default auth.uid() references public.profiles(id) on delete set null,
  body       text check (body is null or char_length(body) <= 2000),
  file_ids   uuid[],
  reply_to   uuid,   -- без внешнего ключа: после удаления оригинала в чате видно «сообщение удалено»
  reply_file uuid,
  created_at timestamptz not null default now(),
  check (body is not null or coalesce(array_length(file_ids, 1), 0) > 0),
  check (coalesce(array_length(file_ids, 1), 0) <= 20)
);
create index if not exists messages_created_idx on public.messages (created_at desc);
create index if not exists files_created_idx on public.files (created_at desc);

create table if not exists public.releases (
  gh_id        bigint primary key,
  tag          text not null default '',
  name         text not null default '',
  body         text not null default '',
  prerelease   boolean not null default false,
  html_url     text not null default '',
  published_at timestamptz,
  assets       jsonb not null default '[]'::jsonb,
  shared       boolean not null default false,
  synced_at    timestamptz
);

create table if not exists public.settings (
  key   text primary key,
  value text
);

-- ============ 2. Помощники для проверки прав ============

create or replace function public.sp_is_approved() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and approved);
$$;

create or replace function public.sp_is_dev() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and approved and role = 'developer');
$$;

-- ============ 3. Регистрация: кодовое слово и первый разработчик ============

create or replace function public.sp_handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  meta  jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  inv   text;
  given text;
  want  text;
  nm    text;
begin
  select value into inv from public.settings where key = 'invite';
  given := lower(trim(coalesce(meta->>'invite', '')));
  if inv is null or given = '' or given <> lower(trim(inv)) then
    raise exception 'invalid_invite';
  end if;

  want := case when meta->>'role' = 'developer' then 'developer' else 'artist' end;
  nm := left(coalesce(nullif(trim(meta->>'name'), ''), 'Участник'), 40);

  if not exists (select 1 from public.profiles where role = 'developer' and approved) then
    -- Первый зарегистрированный становится разработчиком сразу.
    insert into public.profiles (id, name, role, requested_role, approved)
    values (new.id, nm, 'developer', 'developer', true);
  else
    insert into public.profiles (id, name, role, requested_role, approved)
    values (new.id, nm, null, want, false);
  end if;
  return new;
end;
$$;

drop trigger if exists sp_on_auth_user_created on auth.users;
create trigger sp_on_auth_user_created
  after insert on auth.users
  for each row execute function public.sp_handle_new_user();

-- ============ 4. Управление участниками (вызывается из приложения) ============

create or replace function public.set_member(target uuid, do_approve boolean, new_role text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.sp_is_dev() then raise exception 'forbidden'; end if;
  if target = auth.uid() then raise exception 'Нельзя менять собственную роль и доступ'; end if;
  if do_approve then
    update public.profiles set approved = true, role = coalesce(new_role, requested_role) where id = target;
  else
    update public.profiles set approved = false, requested_role = coalesce(role, requested_role), role = null where id = target;
  end if;
end;
$$;

create or replace function public.remove_member(target uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.sp_is_dev() then raise exception 'forbidden'; end if;
  if target = auth.uid() then raise exception 'Нельзя удалить самого себя'; end if;
  delete from auth.users where id = target;
end;
$$;

revoke all on function public.set_member(uuid, boolean, text) from public, anon;
revoke all on function public.remove_member(uuid) from public, anon;
grant execute on function public.set_member(uuid, boolean, text) to authenticated;
grant execute on function public.remove_member(uuid) to authenticated;
grant execute on function public.sp_is_approved() to authenticated;
grant execute on function public.sp_is_dev() to authenticated;

-- ============ 5. Правила для файлов: размер и общий лимит ============
-- Если меняете лимиты, меняйте и в config.js (STORAGE_LIMIT_MB, MAX_FILE_MB).

create or replace function public.sp_check_file() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.size > 30 * 1048576 then
    raise exception 'Файл больше 30 МБ';
  end if;
  if split_part(new.path, '/', 1) <> new.uploader::text then
    raise exception 'Неверный путь файла';
  end if;
  if (select coalesce(sum(size), 0) from public.files) + new.size > 900::bigint * 1048576 then
    raise exception 'storage_quota';
  end if;
  return new;
end;
$$;

drop trigger if exists sp_files_check on public.files;
create trigger sp_files_check before insert on public.files
  for each row execute function public.sp_check_file();

-- ============ 6. Права доступа к таблицам (RLS) ============

alter table public.profiles enable row level security;
alter table public.files    enable row level security;
alter table public.messages enable row level security;
alter table public.releases enable row level security;
alter table public.settings enable row level security;

revoke all on public.profiles, public.files, public.messages, public.releases, public.settings from anon;
grant usage on schema public to authenticated;
grant select on public.profiles to authenticated;
grant select, insert, delete on public.files, public.messages to authenticated;
grant select, insert, update, delete on public.releases, public.settings to authenticated;

-- profiles: свою строку видит каждый, остальных видят подтверждённые (неподтверждённых только разработчик)
drop policy if exists sp_profiles_select on public.profiles;
create policy sp_profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or (public.sp_is_approved() and (approved or public.sp_is_dev())));

-- messages
drop policy if exists sp_messages_select on public.messages;
create policy sp_messages_select on public.messages for select to authenticated
  using (public.sp_is_approved());
drop policy if exists sp_messages_insert on public.messages;
create policy sp_messages_insert on public.messages for insert to authenticated
  with check (public.sp_is_approved() and author = auth.uid());
drop policy if exists sp_messages_delete on public.messages;
create policy sp_messages_delete on public.messages for delete to authenticated
  using (public.sp_is_approved() and (author = auth.uid() or public.sp_is_dev()));

-- files
drop policy if exists sp_files_select on public.files;
create policy sp_files_select on public.files for select to authenticated
  using (public.sp_is_approved());
drop policy if exists sp_files_insert on public.files;
create policy sp_files_insert on public.files for insert to authenticated
  with check (public.sp_is_approved() and uploader = auth.uid());
drop policy if exists sp_files_delete on public.files;
create policy sp_files_delete on public.files for delete to authenticated
  using (public.sp_is_approved() and (uploader = auth.uid() or public.sp_is_dev()));

-- releases: разработчик видит всё, художник только открытые
drop policy if exists sp_releases_select on public.releases;
create policy sp_releases_select on public.releases for select to authenticated
  using (public.sp_is_dev() or (public.sp_is_approved() and shared));
drop policy if exists sp_releases_insert on public.releases;
create policy sp_releases_insert on public.releases for insert to authenticated
  with check (public.sp_is_dev());
drop policy if exists sp_releases_update on public.releases;
create policy sp_releases_update on public.releases for update to authenticated
  using (public.sp_is_dev()) with check (public.sp_is_dev());
drop policy if exists sp_releases_delete on public.releases;
create policy sp_releases_delete on public.releases for delete to authenticated
  using (public.sp_is_dev());

-- settings: кодовое слово видит только разработчик
drop policy if exists sp_settings_select on public.settings;
create policy sp_settings_select on public.settings for select to authenticated
  using (public.sp_is_approved() and (key <> 'invite' or public.sp_is_dev()));
drop policy if exists sp_settings_insert on public.settings;
create policy sp_settings_insert on public.settings for insert to authenticated
  with check (public.sp_is_dev());
drop policy if exists sp_settings_update on public.settings;
create policy sp_settings_update on public.settings for update to authenticated
  using (public.sp_is_dev()) with check (public.sp_is_dev());
drop policy if exists sp_settings_delete on public.settings;
create policy sp_settings_delete on public.settings for delete to authenticated
  using (public.sp_is_dev());

-- ============ 7. Хранилище файлов ============

insert into storage.buckets (id, name, public, file_size_limit)
values ('sprites', 'sprites', false, 31457280)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

drop policy if exists sp_storage_select on storage.objects;
create policy sp_storage_select on storage.objects for select to authenticated
  using (bucket_id = 'sprites' and public.sp_is_approved());

drop policy if exists sp_storage_insert on storage.objects;
create policy sp_storage_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'sprites' and public.sp_is_approved()
              and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists sp_storage_delete on storage.objects;
create policy sp_storage_delete on storage.objects for delete to authenticated
  using (bucket_id = 'sprites' and public.sp_is_approved()
         and ((storage.foldername(name))[1] = auth.uid()::text or public.sp_is_dev()));

-- ============ 8. Живые обновления (Realtime) ============

do $$
declare t text;
begin
  foreach t in array array['messages', 'files', 'releases', 'profiles', 'settings'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end;
$$;
