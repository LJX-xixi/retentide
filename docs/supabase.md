# Cloud sync and AI analysis with Supabase (optional)

Without Supabase the app keeps everything in your browser. Connect your own free Supabase project to sync
between devices and to let an AI assistant read your study records.

## 1. Create the project and tables

1. Create a project at <https://supabase.com>.
2. SQL Editor → paste `supabase/migrations/0001_init.sql` → Run. It creates:
   - `documents` — the app's sync data (one row per document, revision-checked writes)
   - `reviews` — one row per answer, append-only, keyed by a per-answer `event_id`
   - views `cards_v`, `daily_v`, `retention_v`, `hard_words_v` (`security_invoker`, so they obey RLS)
   Row-level security limits every table to the signed-in user.
3. Authentication → URL Configuration → add your app's address (e.g. `http://localhost:8080` and your
   GitHub Pages URL) to **Redirect URLs**, so the sign-in link can return to it.

## 2. Connect the app

Settings → Supabase: paste **Project URL** and the **anon public key** (Project Settings → API), save, then
enter your email and click the sign-in link you receive. Progress made in this browser before signing in
merges into the account (newest wins per word) and uploads; the anonymous copy is then removed. Never use the `service_role` key in the app.

Imported word lists and question sets are device-local. Use Settings → Export progress / Import progress to carry both the material and records to another device. Version 3 backups include both; older backups only restore records.

How sync behaves:
- Each device writes to its browser first and uploads in batches; a stale tab cannot overwrite newer cards
  (cards merge one by one, newest wins; writes are conditional on the row revision).
- Each account has its own local store: signing in as someone else on the same browser never shows or
  uploads the previous account's data.
- Answers are logged on the device at answer time and upserted by `event_id`, so retries never duplicate.

## 3. Let an AI read your records

**Option A — official Supabase MCP server** (Claude, Cursor, ChatGPT and other MCP clients). Use read-only
mode and scope it to this one project:

```
https://mcp.supabase.com/mcp?project_ref=<your-project-ref>&read_only=true
```

The MCP server acts with your developer account's permissions, not as the app user, so read-only mode and
project scoping are what keep it from changing data. Point the assistant at the views, e.g.:

> Query `daily_v` and `retention_v` for the last two weeks. Which question types are below 85% observed
> recall, and is predicted recall well calibrated?

**Option B — no database access.** Settings → “导出给 AI 分析 / Export for AI” downloads one Markdown file
(summary + every answer as CSV) that you can attach to any chat.

## Useful queries

```sql
-- accuracy of first spaced reviews, by question type
select kind, count(*), round(avg(correct::int), 3) as accuracy
from reviews where scheduled and stability_before is not null group by kind order by 2 desc;

-- calibration: predicted vs observed recall
select predicted_bucket, sum(n) as n, round(sum(predicted * n) / sum(n), 2) as predicted, round(sum(observed * n) / sum(n), 2) as observed
from retention_v group by predicted_bucket order by predicted_bucket;

-- what keeps going wrong
select * from hard_words_v order by wrong desc limit 20;
```
