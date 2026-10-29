#!/usr/bin/env python3
"""Add a prior difficulty (`df`) and a screening flag (`scr`) to your own word list, from word frequency.

    pip install wordfreq
    python3 scripts/enrich_list.py my-list.json my-list.enriched.json

Rare words get a higher df (FSRS starts them a little harder and shows the card before testing); frequent
words are marked `scr`, so one quick timed check can skip them. Values you set by hand are kept.
wordfreq's data is CC BY-SA 4.0: the numbers this adds to your file carry that license (see NOTICE).
"""
import json
import sys

from wordfreq import zipf_frequency


def prior(word: str) -> tuple[float, bool]:
    z = max((zipf_frequency(t, "en") for t in word.lower().split()), default=0.0)
    # Zipf 5+ everyday words ≈ 0.1; 3 (once per million words) ≈ 0.55; below 2 ≈ 0.9
    df = min(0.95, max(0.05, 0.1 + (5.0 - z) * 0.225))
    return round(df, 2), z >= 4.0


def main(src: str, dst: str) -> None:
    data = json.load(open(src, encoding="utf-8"))
    words = data["words"] if isinstance(data, dict) else data
    for w in words:
        df, common = prior(w["w"])
        w.setdefault("df", df)
        if common and "scr" not in w and "trap" not in w.get("tags", []):
            w["scr"] = True
    json.dump(data, open(dst, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"{len(words)} words → {dst}")


if __name__ == "__main__":
    main(*sys.argv[1:3])
