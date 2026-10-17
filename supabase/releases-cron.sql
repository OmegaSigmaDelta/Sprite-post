-- Sprite Post: автосверка релизов с GitHub прямо в базе (необязательно, шаг 9 руководства).
-- Каждые 15 минут база сама спрашивает GitHub и обновляет список релизов,
-- даже если ни одна страница не открыта. Репозиторий должен быть публичным.

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

-- Шаг 1: отправить запрос к GitHub.
create or replace function public.sp_request_releases() returns void
language plpgsql security definer set search_path = public, extensions as $$
declare
  repo text;
  rid  bigint;
begin
  select coalesce((select value from public.settings where key = 'repo'),
                  'OmegaSigmaDelta/Sierra-Tango-Kasper-Echo') into repo;
  if repo !~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' then return; end if;

  select net.http_get(
    url := 'https://api.github.com/repos/' || repo || '/releases?per_page=30',
    headers := jsonb_build_object('Accept', 'application/vnd.github+json', 'User-Agent', 'sprite-post')
  ) into rid;

  insert into public.settings (key, value) values ('gh_request', rid::text)
  on conflict (key) do update set value = excluded.value;
end;
$$;

-- Шаг 2: через пару минут забрать ответ и записать релизы.
create or replace function public.sp_apply_releases() returns void
language plpgsql security definer set search_path = public as $$
declare
  rid  bigint;
  resp record;
  j    jsonb;
  r    jsonb;
  ids  bigint[] := '{}';
  pre  boolean;
  ast  jsonb;
begin
  select value::bigint into rid from public.settings where key = 'gh_request';
  if rid is null then return; end if;

  select status_code, content into resp from net._http_response where id = rid;
  if not found or resp.status_code is distinct from 200 then return; end if;

  j := resp.content::jsonb;
  if jsonb_typeof(j) <> 'array' then return; end if;

  for r in select * from jsonb_array_elements(j) loop
    if coalesce((r->>'draft')::boolean, false) then continue; end if;
    pre := coalesce((r->>'prerelease')::boolean, false);
    select coalesce(jsonb_agg(jsonb_build_object(
             'name', a->>'name', 'size', (a->>'size')::bigint, 'url', a->>'browser_download_url')), '[]'::jsonb)
      into ast
      from jsonb_array_elements(coalesce(r->'assets', '[]'::jsonb)) a;

    insert into public.releases (gh_id, tag, name, body, prerelease, html_url, published_at, assets, shared, synced_at)
    values ((r->>'id')::bigint, coalesce(r->>'tag_name', ''), coalesce(r->>'name', ''), coalesce(r->>'body', ''),
            pre, coalesce(r->>'html_url', ''), coalesce(r->>'published_at', r->>'created_at')::timestamptz,
            ast, not pre, now())
    on conflict (gh_id) do update set
      tag = excluded.tag, name = excluded.name, body = excluded.body, prerelease = excluded.prerelease,
      html_url = excluded.html_url, published_at = excluded.published_at, assets = excluded.assets,
      synced_at = excluded.synced_at;   -- поле shared не трогаем: выбор разработчика сохраняется
    ids := ids || (r->>'id')::bigint;
  end loop;

  if coalesce(array_length(ids, 1), 0) < 30 then
    delete from public.releases where not (gh_id = any (ids));
  end if;

  insert into public.settings (key, value) values ('releases_synced_at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
  on conflict (key) do update set value = excluded.value;
  delete from public.settings where key = 'gh_request';
end;
$$;

revoke all on function public.sp_request_releases() from public, anon, authenticated;
revoke all on function public.sp_apply_releases() from public, anon, authenticated;

-- Расписание: запрос в 0, 15, 30, 45 минут, обработка ответа на 2-й минуте после каждого запроса.
select cron.schedule('sp-releases-request', '*/15 * * * *', 'select public.sp_request_releases()');
select cron.schedule('sp-releases-apply', '2-59/15 * * * *', 'select public.sp_apply_releases()');

-- Отключить автосверку:
--   select cron.unschedule('sp-releases-request');
--   select cron.unschedule('sp-releases-apply');
