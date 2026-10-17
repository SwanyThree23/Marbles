-- Confirming an email address: a link is mailed at sign-up (and on request). Password-reset
-- emails only go to confirmed addresses, so a typo at sign-up cannot hand the account to
-- whoever owns the mistyped address.
alter table users add column if not exists email_verified_at timestamptz;

create table if not exists email_verifications (
  token_hash text primary key,
  user_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);
create index if not exists idx_email_verifications_user on email_verifications (user_id);
alter table email_verifications enable row level security;  -- server-only
