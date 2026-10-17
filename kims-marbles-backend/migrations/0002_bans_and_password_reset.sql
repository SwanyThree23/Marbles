-- Moderators can suspend an account; people can reset a forgotten password by email.
-- Written to be safe on a fresh install too (schema.sql already has these).
alter table users add column if not exists banned_at timestamptz;
alter table users add column if not exists banned_reason text not null default '';
alter table users add column if not exists banned_by uuid references users(id) on delete set null;

-- one row per emailed reset link; only the sha-256 of the token is stored
create table if not exists password_resets (
  token_hash text primary key,
  user_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);
create index if not exists idx_password_resets_user on password_resets (user_id);
alter table password_resets enable row level security;  -- server-only, like refresh_tokens
