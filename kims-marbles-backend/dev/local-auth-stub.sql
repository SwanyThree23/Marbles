-- LOCAL DEVELOPMENT AND TESTS ONLY. Never apply to Supabase (it already has auth.uid()).
-- Mirrors Supabase: auth.uid() is the `sub` claim of the request's JWT, which a test sets with
--   select set_config('request.jwt.claim.sub', '<user uuid>', true);
create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
end $$;
grant usage on schema public, auth to authenticated;
