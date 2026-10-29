# Word list and question set formats

Import either in **Settings → 词表 / Word list**. Imported data stays in your browser. Version 3 progress backups include the active word list and question set so they can be restored on another device. Restoring replaces that device's active study material; progress is merged. Supabase sync alone does not transfer imported material.

## Word list — CSV

One row per sense. A header row starting with `word` is optional.

```csv
word,pos,zh,en,example,example_zh,synonyms
placate,v.t.,平息，安抚,to calm someone by giving in a little,"She tried to placate the critics with a minor concession.",她用一点小让步来安抚批评者。,appease;mollify
```

Rows with the same `word` become one entry with several senses. `zh` may be left empty (the English
definition is shown instead); `synonyms` are separated by `;`.

## Word list — JSON

```json
{
  "name": "My list",
  "words": [
    {
      "id": "placate",                 // optional; derived from the word
      "w": "placate",
      "tags": ["core"],                // optional; "trap" = tested on an uncommon sense (see trapSenses)
      "senses": [{ "pos": "v.t.", "zh": "平息，安抚", "en": "to calm someone by giving in a little",
                   "ex": [{ "en": "…", "zh": "…" }] }],
      "syn": ["appease", "mollify"],   // optional; used by pick-the-synonym questions
      "ant": ["provoke"],              // optional
      "conf": ["placid"],              // optional; ids of look-alike words in the same list
      "df": 0.5,                       // optional prior difficulty 0 (easy) … 1 (rare); default 0.5
      "scr": true,                     // optional; common word → offered for quick screening
      "trapSenses": [ … ]              // optional; with tag "trap", the senses to test
    }
  ]
}
```

A bare array of entries is also accepted. Look-alike groups are built from `conf`.

How the optional fields are used:

| Field | Effect |
|---|---|
| `df` | Shifts the first FSRS difficulty by up to ±1 and decides card-first (≥ 0.6) vs test-first for new words |
| `scr` | The word may be skipped by one quick timed check, re-checked after 45 days |
| `conf` | Look-alikes become distractors and get a dedicated drill |
| `syn` | Enables pick-the-synonym questions |
| `tags: ["trap"]` + `trapSenses` | The uncommon sense is what gets tested |

`scripts/enrich_list.py` can fill `df` and `scr` from word frequencies for your own list.

## Question set — JSON (optional)

Text completion / sentence equivalence style items, done section by section:

```json
{
  "name": "My question set",
  "items": [
    { "id": "s1-1", "sec": 1, "n": 1, "type": "tc1",
      "text": "Her critics found the speech ____, padded with stock phrases.",
      "blanks": [{ "options": ["hackneyed", "incisive", "terse", "candid", "lucid"], "answer": 0 }],
      "why": "\"padded with stock phrases\" restates the blank." },
    { "id": "s1-2", "sec": 1, "n": 2, "type": "se",
      "text": "…____…",
      "options": ["a", "b", "c", "d", "e", "f"], "answers": [1, 4], "why": "…" }
  ],
  "pool": ["optional", "answer", "words", "for", "AI-written", "items"]
}
```

`type`: `tc1` (one blank, five options), `tc2` / `tc3` (two or three blanks, three options each, one
`blanks` entry per blank), `se` (six options, two answers). Only import questions you have the right to use.
