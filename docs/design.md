# Design notes

How the app turns answers into a schedule, and why. Every rule here is a deliberate choice that can be
questioned; the review log records enough to test them (see “Research questions” in the README).

## Automatic grading

Learners never rate their own recall. Each answer is mapped to an FSRS grade (`rate()` in app.js):

| Outcome | Grade |
|---|---|
| Wrong, or “don't know” | 1 Again |
| Right but slow: > 1.6 × your median for *that question type*, with a floor (4 s for meaning/word choice, 6 s for definition and synonym items; +0.25 s per word of a long English definition) | 2 Hard |
| Right at normal speed | 3 Good |
| Right and fast (< 0.6 × median) on a harder, context-based item | 4 Easy |

Timing is per question type because reading an English definition genuinely takes longer than picking a
Chinese gloss. Typed answers are not timed (typing speed is noise). Easy needs a harder item: a quick lucky
pick on a four-option recognition question should not stretch the interval.

Guards against over-crediting:
- **Lookup cap.** A word you looked up in the last 24 hours can earn at most Good: you just saw the answer.
- **Weak evidence.** A correct easy recognition item on a word past that stage, or practising a word that
  isn't due, does not lengthen the interval. Wrong answers always count.
- **First check** of a new word is capped at Good (about three days).

The answer screen shows the reasoning (“为什么 / Why”): the time limit that applied, any cap, the FSRS
stability, and the resulting date.

## Scheduling

FSRS-5 with the published default parameters, target retention 0.9. The word's prior difficulty `df`
(0 easy … 1 rare) shifts the first difficulty estimate by up to ±1, so rare words start a little harder;
reviews take over from there.

## New words: test first or card first

- Likely-known words (`df` < 0.6) are tested before any card: guessing first and then seeing the answer helps
  memory, and known words skip the card entirely.
- Likely-unknown words get the card first (a pre-test would be blind guessing), then a check a few items later
  with distractors from the same batch.
- Words marked `scr` (common) get one timed check; a fast correct answer skips them for 45 days.

## Question ladder

The item type follows memory stability: recognition (meaning ↔ word) → definition, example cloze and
pick-the-synonym → typed meaning and AI-written context items. Distractors come from look-alikes first, then
words you have confused before, then the same part of speech; synonyms are excluded.

## Data the app records per answer

`event_id`, time, question type, correct, response time, grade (or none), whether it moved the schedule,
whether the lookup cap applied, stability / difficulty / predicted recall **before** the answer, and the rule
version (`ALGO_VERSION`). Recording the pre-answer state at answer time is what makes later evaluation
possible: it cannot be reconstructed from the final card state.
