# Retentide

English | [简体中文](README.zh-CN.md)

Retentide is an open-source vocabulary app for everyday learning. An AI tutor explains words and gives you
practice in context, and FSRS schedules your reviews so each word comes back around the time you would start
to forget it. The name is retention plus tide: what you remember ebbs between reviews.

It runs in the browser with no account. The AI tutor, dictionary and sync use your own keys.

## Learning with the AI tutor

Connect any OpenAI-compatible endpoint that accepts browser requests, and the tutor can:

- explain a word: its roots or a memory hook, how it differs from look-alikes and near-synonyms, and new
  example sentences;
- talk about a word with you, with that word's entry, your notes and your record with it already in view;
  you can attach a screenshot of a question;
- write fill-in-the-blank and sentence-equivalence questions around the words you are learning, in the
  style of real exam items, and explain the answers;
- judge a meaning you type in your own words;
- look over your last three weeks of mistakes and suggest what to practise.

Your answer history can also go to any AI you use: export it as one Markdown file, or let an AI query your
Supabase project read-only ([setup](docs/supabase.md)).

## Reviewing on schedule

Each day the app puts due reviews first, then a set number of new words, and cuts back new words when reviews
pile up. FSRS-5 decides when each word comes back.

You don't rate yourself after each card. The app grades the answer from whether it was right, how long you
took compared with your usual time on that kind of question, and whether you looked the word up in the last
24 hours, and it shows the reasoning on the answer screen. New words you probably know are tested before the
card; rare ones are shown first. These rules are reasoned design choices, not validated findings; details are
in [docs/design.md](docs/design.md).

Questions move from recognition (word to meaning and back) to English definitions, example sentences with a
blank, picking a synonym and typing the meaning as a word settles in. Look-alike words and words you have
mixed up before are used as wrong options.

## Words and data

It comes with an original sample deck of 150 advanced English words (CC BY 4.0). You can import your own list
as CSV or JSON, and a question set too; the formats are in [data/schema.md](data/schema.md). The word bank has
search, filters and an overview grid for skimming.

Merriam-Webster definitions and audio are available with your free key, looked up only when you ask and never
saved to your word list
([policy](docs/merriam-webster.md)). Progress stays in your browser unless you connect your own Supabase
project to sync between devices. JSON backups include the active word list, question set and learning records.
Restoring a backup restores its study material and merges progress. Imported lists and question sets stay
local; use a backup to carry them to another device. The interface is in Chinese or English.

## Running it

There is no build step. Serve the folder with any static server:

```bash
python3 -m http.server 8080
```

Then open <http://localhost:8080>. To deploy, put the folder on GitHub Pages or any static host. Keys you enter
in Settings stay in your browser.

## Tests

```bash
npm test
```

The tests cover the FSRS scheduler and grading rules, the sync merge rules (including two tabs writing at once),
the dictionary parser (on a hand-written fixture) and the sample deck's format. CI runs them on every push.

## Project layout

```
index.html, app.js, chat.js, practice.js   the app (vanilla JS)
runtime/          storage, AI, dictionary adapters behind window.vocabRuntime
i18n/             L(zh, en) helper for the two interface languages
data/             sample deck (CC BY 4.0) and import formats
supabase/         SQL: tables, RLS, analysis views
docs/             design notes, Merriam-Webster policy, Supabase + AI setup
scripts/          tests, optional frequency enrichment for your own list
```

## Research questions

Because the app records, at answer time, the memory state FSRS predicted before each answer, a few questions can
be checked on real use. They are open questions, not claims:

1. Does capping grades after a lookup reduce over-estimation of what is known (predicted vs. observed recall on
   the next unaided review)?
2. Can automatic grading replace self-rating without hurting schedule quality, and how often would a learner
   have rated differently? (This needs a self-rating control condition; the logs alone can only measure how
   well the current predictions are calibrated.)
3. Does success on recognition items predict success on context items for the same word?

`retention_v` in the Supabase schema is a first calibration view. A replay/evaluation script is planned.

## Limitations

- Without Supabase, progress lives in browser storage (a few MB), so export a backup now and then.
- AI providers must support OpenAI-compatible Chat Completions, streaming, JSON and tool calls, and allow
  browser requests (CORS). Choose your own provider and model in Settings. Keys entered in the browser are
  visible to anyone using that browser profile.
- FSRS uses its default parameters; there is no per-user parameter fitting yet.

## License

Code: MIT (`LICENSE`). Sample deck: CC BY 4.0 (`data/LICENSE`). Third parties: `NOTICE`. Merriam-Webster content
is subject to Merriam-Webster's terms and is not distributed here.

