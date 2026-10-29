# Merriam-Webster (optional)

The app can show Merriam-Webster definitions, pronunciations and thesaurus entries using **your own free
keys**. This project is not affiliated with or endorsed by Merriam-Webster, and MW content is not covered by
this repository's licenses.

## Get keys

1. Register at <https://dictionaryapi.com/register/index>.
2. Request **Merriam-Webster's Collegiate® Dictionary with Audio** and, optionally, **Merriam-Webster's
   Collegiate® Thesaurus** (the free plan allows two reference works).
3. In the app: **Settings → Merriam-Webster**, paste the keys, save.

The free plan is for **non-commercial use** and has a daily request limit per key — see the
[terms of service](https://dictionaryapi.com/info/terms-of-service). If you deploy this app for others,
each person should use their own key; do not put a key in the source code or a shared deployment.

## What the app does with MW

| | |
|---|---|
| When it queries | Only when you ask: the “Merriam-Webster” button on a word card, the word-lookup box, or selecting a word |
| Automatic or background lookups | None. If you paste several words into the lookup box, each word not in your list is looked up once (at most 20 words per entry, two requests at a time), because you asked for those words |
| Storage | Results stay in memory for the current page visit; nothing is saved to the browser, to Supabase, or to your word list. Adding a new word needs the AI tutor to write the entry; MW definitions are never used as a fallback entry |
| AI | MW text is never sent to the AI tutor (`MW_TO_AI = false` in app.js) |
| Attribution | The Merriam-Webster logo (unmodified, ® visible, 50 px) and the product name “Merriam-Webster's Collegiate® Dictionary” appear with every result and in Settings, linking to merriam-webster.com. The logo is loaded from dictionaryapi.com, not stored in this repository |

The logo and naming follow Merriam-Webster's [brand guidelines](https://dictionaryapi.com/info/branding-guidelines).

These are deliberately conservative defaults. Caching responses or passing MW text to a model would need
confirmation from Merriam-Webster first; the switches `MW_PERSIST` and `MW_TO_AI` exist so that a deployment
with that permission can turn them on.

Requests go from your browser straight to `dictionaryapi.com` (it allows cross-origin requests), so your key
is visible to you in your own browser and nowhere else.
