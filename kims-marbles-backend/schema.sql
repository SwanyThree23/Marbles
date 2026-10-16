-- Kim's Marbles — full Postgres schema (Supabase-compatible). Apply on an EMPTY database,
-- then rls.sql. Money is always integer cents. Every id is a uuid.
create extension if not exists "uuid-ossp";

-- ---------------------------------------------------------------- people
create table users (
  id uuid primary key default uuid_generate_v4(),
  handle text not null check (handle ~ '^[A-Za-z0-9_]{3,24}$'),
  email text not null check (length(email) between 3 and 254),
  password_hash text not null,
  avatar_icon text not null default '👤',
  bio text not null default '' check (length(bio) <= 280),
  is_admin boolean not null default false,
  stripe_account_id text,
  created_at timestamptz not null default now()
);
create unique index uq_users_handle on users (lower(handle));
create unique index uq_users_email on users (lower(email));

-- one row per issued refresh token; one login = one family. Only the sha-256 hash is stored.
create table refresh_tokens (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references users(id) on delete cascade,
  family_id uuid not null,
  token_hash text unique not null,
  created_at timestamptz default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_reason text
);
create index idx_refresh_tokens_user on refresh_tokens(user_id);
create index idx_refresh_tokens_family on refresh_tokens(family_id);

create table follows (
  follower_id uuid not null references users(id) on delete cascade,
  followee_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_id, followee_id),
  check (follower_id <> followee_id)
);

-- ---------------------------------------------------------------- marketplace
create table listings (
  id uuid primary key default uuid_generate_v4(),
  seller_id uuid not null references users(id) on delete cascade,
  name text not null check (length(name) between 1 and 120),
  description text not null default '' check (length(description) <= 2000),
  category text not null check (length(category) between 1 and 40),
  grade text not null check (grade in ('mint', 'near-mint', 'good')),
  type text not null check (type in ('sale', 'trade', 'auction')),
  price_cents integer not null default 0 check (price_cents >= 0),
  status text not null default 'active' check (status in ('active', 'sold', 'removed')),
  current_bid_cents integer check (current_bid_cents >= 0),
  current_bidder_id uuid references users(id) on delete set null,
  min_increment_cents integer not null default 500 check (min_increment_cents > 0),
  ends_at timestamptz,
  created_at timestamptz not null default now()
);
create index idx_listings_active on listings (status, created_at desc);
create index idx_listings_seller on listings (seller_id);

create table bids (
  id uuid primary key default uuid_generate_v4(),
  listing_id uuid not null references listings(id) on delete cascade,
  bidder_id uuid not null references users(id) on delete cascade,
  amount_cents integer not null check (amount_cents > 0),
  created_at timestamptz not null default now()
);
create index idx_bids_listing on bids (listing_id, amount_cents desc);

create table offers (
  id uuid primary key default uuid_generate_v4(),
  listing_id uuid not null references listings(id) on delete cascade,
  buyer_id uuid not null references users(id) on delete cascade,
  kind text not null check (kind in ('buy', 'offer', 'trade')),
  offer_amount_cents integer check (offer_amount_cents > 0),
  trade_item_ids uuid[] not null default '{}',
  message text not null default '' check (length(message) <= 1000),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'paid')),
  created_at timestamptz not null default now()
);
create index idx_offers_listing on offers (listing_id);
create index idx_offers_buyer on offers (buyer_id);

create table collection_items (
  id uuid primary key default uuid_generate_v4(),
  owner_id uuid not null references users(id) on delete cascade,
  name text not null check (length(name) between 1 and 80),
  icon text not null default '🔮',
  est_value_cents integer not null default 0 check (est_value_cents between 0 and 2000000000),
  acquired_via uuid references listings(id) on delete set null,
  created_at timestamptz not null default now()
);
create index idx_collection_owner on collection_items (owner_id);

create table listing_templates (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references users(id) on delete cascade,
  name text not null, category text not null,
  grade text not null check (grade in ('mint', 'near-mint', 'good')),
  type text not null check (type in ('sale', 'trade', 'auction')),
  price_cents integer not null default 0, description text not null default '',
  created_at timestamptz default now(), updated_at timestamptz default now()
);
create unique index uq_listing_templates_user_name on listing_templates(user_id, lower(name));

-- ---------------------------------------------------------------- live rooms
create table rooms (
  id uuid primary key default uuid_generate_v4(),
  host_id uuid not null references users(id) on delete cascade,
  title text not null check (length(title) between 1 and 120),
  category text not null default 'General' check (length(category) <= 40),
  status text not null default 'scheduled' check (status in ('scheduled', 'live', 'ended')),
  max_guests integer not null default 6 check (max_guests between 1 and 50),
  scheduled_for timestamptz,
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now()
);
create index idx_rooms_status on rooms (status, created_at desc);
create index idx_rooms_host on rooms (host_id);

create table room_participants (
  room_id uuid not null references rooms(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  primary key (room_id, user_id)
);

create table room_invites (
  token_hash text primary key,
  room_id uuid not null references rooms(id) on delete cascade,
  created_by uuid not null references users(id) on delete cascade,
  claimed_by uuid references users(id) on delete set null,
  claimed_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table watchparty_state (
  room_id uuid primary key references rooms(id) on delete cascade,
  youtube_id text check (youtube_id ~ '^[A-Za-z0-9_-]{11}$'),
  title text not null default '',
  playing boolean not null default false,
  updated_at timestamptz not null default now()
);
create table watchparty_queue (
  id uuid primary key default uuid_generate_v4(),
  room_id uuid not null references rooms(id) on delete cascade,
  youtube_id text not null check (youtube_id ~ '^[A-Za-z0-9_-]{11}$'),
  title text not null default '' check (length(title) <= 120),
  added_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index idx_wp_queue_room on watchparty_queue (room_id, created_at);

create table room_chat (
  id bigserial primary key,
  room_id uuid not null references rooms(id) on delete cascade,
  user_id uuid references users(id) on delete set null,
  text text not null check (length(text) between 1 and 500),
  created_at timestamptz not null default now()
);
create index idx_room_chat_room on room_chat (room_id, id desc);

create table moderation_settings (
  user_id uuid primary key references users(id) on delete cascade,
  enabled boolean not null default false,
  words text[] not null default '{}',
  updated_at timestamptz default now()
);

-- ---------------------------------------------------------------- PK-battles
create table battles (
  id uuid primary key default uuid_generate_v4(),
  challenger_id uuid not null references users(id) on delete cascade,
  opponent_id uuid not null references users(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'live', 'declined', 'ended')),
  wager_type text not null default 'points' check (wager_type in ('points', 'marble')),
  wager_item_id uuid references collection_items(id) on delete set null,
  round_seconds integer not null default 300 check (round_seconds between 60 and 3600),
  challenger_points integer not null default 0,
  opponent_points integer not null default 0,
  winner_id uuid references users(id) on delete set null,
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  check (challenger_id <> opponent_id)
);
create index idx_battles_users on battles (challenger_id, opponent_id);

create table battle_gifts (
  id uuid primary key default uuid_generate_v4(),
  battle_id uuid not null references battles(id) on delete cascade,
  sender_id uuid references users(id) on delete set null,
  side text not null check (side in ('challenger', 'opponent')),
  gift_name text not null check (length(gift_name) between 1 and 40),
  points integer not null check (points between 1 and 10000),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- community
create table posts (
  id uuid primary key default uuid_generate_v4(),
  author_id uuid not null references users(id) on delete cascade,
  text text not null check (length(text) between 1 and 2000),
  attach_item_id uuid references collection_items(id) on delete set null,
  created_at timestamptz not null default now()
);
create index idx_posts_created on posts (created_at desc);
create index idx_posts_author on posts (author_id);

create table post_likes (
  post_id uuid not null references posts(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);
create table post_comments (
  id uuid primary key default uuid_generate_v4(),
  post_id uuid not null references posts(id) on delete cascade,
  author_id uuid not null references users(id) on delete cascade,
  text text not null check (length(text) between 1 and 1000),
  created_at timestamptz not null default now()
);
create index idx_post_comments_post on post_comments (post_id, created_at);

-- one conversation per pair of users; user_a < user_b keeps the pair unique
create table conversations (
  id uuid primary key default uuid_generate_v4(),
  user_a uuid not null references users(id) on delete cascade,
  user_b uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (user_a, user_b),
  check (user_a < user_b)
);
create table messages (
  id bigserial primary key,
  conversation_id uuid not null references conversations(id) on delete cascade,
  sender_id uuid not null references users(id) on delete cascade,
  text text not null check (length(text) between 1 and 2000),
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index idx_messages_conv on messages (conversation_id, id);

create table notifications (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references users(id) on delete cascade,
  type text not null,
  text text not null,
  ref_id uuid,
  read boolean not null default false,
  created_at timestamptz not null default now()
);
create index idx_notifications_user on notifications (user_id, created_at desc);

create table achievements (
  key text primary key,
  name text not null,
  description text not null,
  icon text not null
);
insert into achievements (key, name, description, icon) values
  ('listed', 'First Listing', 'List a marble', '🆕'),
  ('traded', 'Trader', 'Make a deal', '🤝'),
  ('collector', 'Collector', 'Own 3+ marbles', '📦'),
  ('followed', 'Socialite', 'Follow a collector', '👥'),
  ('challenged', 'Rival', 'Send a battle challenge', '⚔️'),
  ('wentLive', 'Broadcaster', 'Go live once', '📡'),
  ('posted', 'Community Voice', 'Post to the feed', '📣'),
  ('quizWhiz', 'Quiz Whiz', 'Score 70%+ on Marble Trivia', '🧠');
create table user_achievements (
  user_id uuid not null references users(id) on delete cascade,
  achievement_key text not null references achievements(key),
  unlocked_at timestamptz not null default now(),
  primary key (user_id, achievement_key)
);

create table activity_events (
  seq bigserial primary key,
  user_id uuid not null references users(id) on delete cascade,
  kind text not null, text text not null, ref_id uuid,
  created_at timestamptz default now()
);
create index idx_activity_user_seq on activity_events(user_id, seq desc);

create table game_scores (
  user_id uuid not null references users(id) on delete cascade,
  game text not null check (game in ('trivia', 'speed')),
  best integer not null default 0, plays integer not null default 0,
  updated_at timestamptz default now(), primary key (user_id, game)
);

create table reports (
  id uuid primary key default uuid_generate_v4(),
  reporter_id uuid not null references users(id) on delete cascade,
  target_type text not null check (target_type in ('listing', 'post', 'user', 'panel', 'comment')),
  target_id uuid not null,
  target_label text not null default '' check (length(target_label) <= 200),
  reason text not null check (length(reason) between 1 and 100),
  details text not null default '' check (length(details) <= 1000),
  status text not null default 'open' check (status in ('open', 'actioned', 'dismissed')),
  resolved_by uuid references users(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
create index idx_reports_status on reports (status, created_at);

-- ---------------------------------------------------------------- payments (Stripe Connect)
create table payments (
  id uuid primary key default uuid_generate_v4(),
  kind text not null check (kind in ('order', 'tip')),
  payer_id uuid references users(id) on delete set null,
  payee_id uuid not null references users(id) on delete cascade,
  offer_id uuid references offers(id) on delete set null,
  room_id uuid references rooms(id) on delete set null,
  amount_cents integer not null check (amount_cents > 0),
  platform_fee_cents integer not null check (platform_fee_cents >= 0),
  message text not null default '' check (length(message) <= 280),
  stripe_session_id text unique,
  status text not null default 'pending' check (status in ('pending', 'paid', 'expired')),
  paid_at timestamptz,
  created_at timestamptz not null default now()
);
-- each Stripe webhook event is handled once, however many times Stripe delivers it
create table processed_webhook_events (
  event_id text primary key,
  processed_at timestamptz not null default now()
);
