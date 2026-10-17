-- Watch-party sync: the room's playback clock. The video is at position_seconds as of
-- updated_at, and moves on from there while playing.
alter table watchparty_state add column if not exists position_seconds double precision not null default 0;
