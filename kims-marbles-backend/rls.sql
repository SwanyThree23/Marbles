-- Row Level Security for every table. Apply after schema.sql.
--
-- The API server connects as the table owner, which bypasses RLS: these policies are the
-- second line of defence for anything that reaches the database directly (Supabase's own
-- REST/realtime endpoints with a user's JWT). auth.uid() is Supabase's "current user";
-- for a plain local Postgres apply dev/local-auth-stub.sql first.
--
-- Tables with RLS on and NO policy are server-only: nobody but the owner role can touch them.

alter table email_verifications enable row level security;   -- server-only (confirmation token hashes)
alter table password_resets enable row level security;        -- server-only (reset token hashes)
alter table users enable row level security;                  -- server-only (holds emails and password hashes)
alter table refresh_tokens enable row level security;         -- server-only
alter table room_invites enable row level security;           -- server-only
alter table processed_webhook_events enable row level security; -- server-only

alter table follows enable row level security;
create policy follows_read on follows for select using (true);
create policy follows_own on follows for insert with check (follower_id = auth.uid());
create policy follows_own_delete on follows for delete using (follower_id = auth.uid());

alter table listings enable row level security;
create policy listings_read on listings for select using (status = 'active' or seller_id = auth.uid());
create policy listings_insert on listings for insert with check (seller_id = auth.uid());
create policy listings_update on listings for update using (seller_id = auth.uid()) with check (seller_id = auth.uid());
create policy listings_delete on listings for delete using (seller_id = auth.uid());

alter table bids enable row level security;
create policy bids_read on bids for select using (true);
create policy bids_insert on bids for insert with check (bidder_id = auth.uid());

alter table offers enable row level security;
create policy offers_read on offers for select using (
  buyer_id = auth.uid() or exists (select 1 from listings l where l.id = listing_id and l.seller_id = auth.uid()));
create policy offers_insert on offers for insert with check (buyer_id = auth.uid());

alter table collection_items enable row level security;
create policy collection_own on collection_items for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

alter table listing_templates enable row level security;
create policy listing_templates_own on listing_templates
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

alter table rooms enable row level security;
create policy rooms_read on rooms for select using (true);
create policy rooms_host on rooms for all using (host_id = auth.uid()) with check (host_id = auth.uid());

alter table room_participants enable row level security;
create policy room_participants_read on room_participants for select using (true);
create policy room_participants_own on room_participants for all using (user_id = auth.uid()) with check (user_id = auth.uid());

alter table watchparty_state enable row level security;
create policy watchparty_state_read on watchparty_state for select using (true);
alter table watchparty_queue enable row level security;
create policy watchparty_queue_read on watchparty_queue for select using (true);

alter table room_chat enable row level security;
create policy room_chat_read on room_chat for select using (true);

alter table moderation_settings enable row level security;
create policy moderation_own on moderation_settings
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

alter table battles enable row level security;
create policy battles_read on battles for select using (true);
alter table battle_gifts enable row level security;
create policy battle_gifts_read on battle_gifts for select using (true);

alter table posts enable row level security;
create policy posts_read on posts for select using (true);
create policy posts_own on posts for insert with check (author_id = auth.uid());
create policy posts_own_delete on posts for delete using (author_id = auth.uid());

alter table post_likes enable row level security;
create policy post_likes_read on post_likes for select using (true);
create policy post_likes_own on post_likes for all using (user_id = auth.uid()) with check (user_id = auth.uid());

alter table post_comments enable row level security;
create policy post_comments_read on post_comments for select using (true);
create policy post_comments_own on post_comments for insert with check (author_id = auth.uid());

alter table conversations enable row level security;
create policy conversations_participant on conversations for select using (auth.uid() in (user_a, user_b));

alter table messages enable row level security;
create policy messages_participant on messages for select using (
  exists (select 1 from conversations c where c.id = conversation_id and auth.uid() in (c.user_a, c.user_b)));

alter table notifications enable row level security;
create policy notifications_own on notifications for select using (user_id = auth.uid());
create policy notifications_own_update on notifications for update using (user_id = auth.uid()) with check (user_id = auth.uid());

alter table achievements enable row level security;
create policy achievements_read on achievements for select using (true);
alter table user_achievements enable row level security;
create policy user_achievements_read on user_achievements for select using (true);   -- badges are public

alter table activity_events enable row level security;
create policy activity_select_own on activity_events for select using (user_id = auth.uid());

alter table game_scores enable row level security;
create policy game_scores_select_own on game_scores for select using (user_id = auth.uid());

alter table reports enable row level security;
create policy reports_own on reports for select using (reporter_id = auth.uid());
create policy reports_insert on reports for insert with check (reporter_id = auth.uid());

alter table payments enable row level security;
create policy payments_party on payments for select using (auth.uid() in (payer_id, payee_id));
