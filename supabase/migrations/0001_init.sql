-- Retentide — optional cloud sync and study analytics on your own Supabase project.
-- Run once in the SQL editor (or `supabase db push`). Every table is private to the signed-in user (RLS);
-- views run with the querying user's permissions (security_invoker), so they inherit the same isolation.

-- App state as documents (the app's own sync format: card buckets, prefs, session logs, notes, chats, custom words)
create table if not exists public.documents (
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  path       text not null check (path ~ '^me(/[A-Za-z0-9_.:@-]+)+$' and length(path) <= 240),
  collection text not null,
  data       jsonb not null,
  revision   integer not null default 1,
  updated_at timestamptz not null default now(),
  primary key (user_id, path)
);
create index if not exists documents_collection on public.documents (user_id, collection);

-- One row per answer, written at answer time on the device and synced idempotently (event_id).
-- *_before / recall_predicted describe memory right before the answer, for evaluating the scheduler.
create table if not exists public.reviews (
  user_id           uuid not null default auth.uid() references auth.users (id) on delete cascade,
  event_id          text not null,
  session_id        text,
  word_id           text not null,
  kind              text not null,          -- question type, e.g. mc_en2zh, cloze_book, screen, learn
  correct           boolean not null,
  ms                integer,                -- response time
  grade             smallint,               -- 1 Again · 2 Hard · 3 Good · 4 Easy; null = not graded
  scheduled         boolean not null default false,  -- this answer moved the next review date
  lookup_capped     boolean not null default false,  -- grade capped: word looked up within 24 h
  stability_before  real,
  difficulty_before real,
  recall_predicted  real,
  algo              text,
  answered_at       timestamptz not null,
  primary key (user_id, event_id)
);
create index if not exists reviews_word on public.reviews (user_id, word_id, answered_at);

alter table public.documents enable row level security;
alter table public.reviews   enable row level security;

drop policy if exists "own documents" on public.documents;
create policy "own documents" on public.documents for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists "own reviews read" on public.reviews;
create policy "own reviews read" on public.reviews for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "own reviews insert" on public.reviews;
create policy "own reviews insert" on public.reviews for insert to authenticated with check (user_id = (select auth.uid()));
-- reviews are an append-only log: no update or delete policy

-- ---------- analysis views (read-only; safe to point an AI at) ----------

-- current memory state per word, unpacked from the card buckets
create or replace view public.cards_v with (security_invoker = true) as
select d.user_id, c.key as word_id,
       (c.value->>'s')::real  as stability_days,
       (c.value->>'d')::real  as difficulty,
       (c.value->>'reps')::int as reps,
       coalesce((c.value->>'lapses')::int, 0) as lapses,
       to_timestamp((c.value->>'due')::bigint / 1000.0)  as due_at,
       to_timestamp((c.value->>'last')::bigint / 1000.0) as last_review_at
from public.documents d, jsonb_each(d.data->'c') c
where d.collection = 'me/cards/b' and (c.value->>'st') is not null;

-- daily volume and accuracy, split into first-time checks and spaced reviews
create or replace view public.daily_v with (security_invoker = true) as
select user_id, (answered_at at time zone 'UTC')::date as day,
       count(*) as answers,
       count(*) filter (where scheduled) as graded,
       round(avg(correct::int)::numeric, 3) as accuracy,
       round((avg(correct::int) filter (where scheduled and stability_before is not null))::numeric, 3) as review_accuracy,
       round((sum(least(coalesce(ms, 0), 120000)) / 60000.0)::numeric, 1) as answer_minutes
from public.reviews group by user_id, day;

-- retention: graded reviews of words already in memory, by predicted recall bucket (calibration check)
create or replace view public.retention_v with (security_invoker = true) as
select user_id, kind,
       width_bucket(recall_predicted, 0, 1, 10) as predicted_bucket,
       count(*) as n,
       round(avg(recall_predicted)::numeric, 3) as predicted,
       round(avg(correct::int)::numeric, 3) as observed
from public.reviews
where scheduled and recall_predicted is not null
group by user_id, kind, predicted_bucket;

-- words that keep going wrong
create or replace view public.hard_words_v with (security_invoker = true) as
select user_id, word_id, count(*) filter (where not correct) as wrong, count(*) as answers,
       max(answered_at) as last_seen
from public.reviews group by user_id, word_id
having count(*) filter (where not correct) >= 2;

grant select on public.cards_v, public.daily_v, public.retention_v, public.hard_words_v to authenticated;
