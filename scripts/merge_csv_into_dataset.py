"""Merge additional sentence pairs from a CSV file into an existing
TranslateGemma fine-tuning dataset (JSONL) and write the combined, de-duplicated
result to a new file. Works for any language pair -- pass --src-lang/--tgt-lang
to match the CSV's two columns.

The JSONL format matches what TranslateGemmaData.TranslationDataset (C#) writes:
one compact JSON object per line:

  {"messages":[
     {"role":"user","content":[{"type":"text","source_lang_code":"hi",
                                "target_lang_code":"xnr","text":"<source>"}]},
     {"role":"assistant","content":[{"type":"text","text":"<target>"}]}]}

Each CSV row (source language in column 1, target language in column 2) is
emitted in BOTH directions (src->tgt and tgt->src), matching the existing
data. Duplicates are removed across the whole combined set using the same key
the C# Deduplicate() uses: (source_lang, target_lang, source_text,
target_text), keeping the first occurrence.

Output is UTF-8 without BOM, "\n" line endings, un-escaped Devanagari.

Usage (--json/--csv/--out/--src-lang/--tgt-lang are all required, since
there's no sensible default language pair or dataset to fall back to):
  python scripts/merge_csv_into_dataset.py --json IN.json --csv NEW.csv \
      --out OUT.json --src-lang hi --tgt-lang xnr

  # a pipe-delimited CSV (e.g. exported from ParallelizeTexts):
  python scripts/merge_csv_into_dataset.py --json XNR2DOG_Matching.json \
      --csv XNR2DOG_ManuallyMatched --out XNR2DOG_BibleCorpus.json \
      --src-lang xnr --tgt-lang dgo --delimiter "|"
"""

import argparse
import csv
import json
import sys
from pathlib import Path


def make_example(src_lang: str, tgt_lang: str, src_text: str, tgt_text: str) -> dict:
    """Build one training example in the TranslateGemma messages format.

    Dict key order deliberately matches the C# serializer's property order so
    the merged file is byte-compatible in style with the existing data.
    """
    return {
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "source_lang_code": src_lang,
                        "target_lang_code": tgt_lang,
                        "text": src_text,
                    }
                ],
            },
            {
                "role": "assistant",
                "content": [{"type": "text", "text": tgt_text}],
            },
        ]
    }


def example_key(example: dict) -> tuple:
    """Dedup key: (source_lang, target_lang, source_text, target_text).

    Mirrors TranslationDataset.Deduplicate() in TranslateGemma.cs. Falls back to
    the raw JSON for any example that doesn't have the expected shape, so
    unusual examples are never silently dropped.
    """
    try:
        user = next(m for m in example["messages"] if m["role"] == "user")
        assistant = next(m for m in example["messages"] if m["role"] == "assistant")
        u = user["content"][0]
        return (
            u.get("source_lang_code"),
            u.get("target_lang_code"),
            u.get("text"),
            assistant["content"][0].get("text"),
        )
    except (KeyError, IndexError, StopIteration):
        return ("__raw__", json.dumps(example, ensure_ascii=False, sort_keys=True))


def load_jsonl(path: Path) -> list:
    examples = []
    with path.open("r", encoding="utf-8-sig") as f:
        for line_no, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                examples.append(json.loads(line))
            except json.JSONDecodeError as ex:
                sys.exit(f"ERROR: {path}, line {line_no}: {ex}")
    return examples


def load_csv_pairs(path: Path, delimiter: str = ",") -> list:
    """Return [(source_text, target_text), ...] from the CSV, skipping the
    header row and any row without both columns filled."""
    pairs = []
    skipped = 0
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.reader(f, delimiter=delimiter)
        header = next(reader, None)  # e.g. "Hindi,Kangri" or "xnr|dgo"
        if header:
            print(f"CSV header: {header}")
        for row in reader:
            if len(row) < 2:
                skipped += 1
                continue
            src_text, tgt_text = row[0].strip(), row[1].strip()
            if not src_text or not tgt_text:
                skipped += 1
                continue
            pairs.append((src_text, tgt_text))
    if skipped:
        print(f"Skipped {skipped} CSV row(s) with missing source or target text.")
    return pairs


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--json", required=True, help="existing JSONL dataset")
    ap.add_argument("--csv", required=True, help="CSV with <source>,<target> columns")
    ap.add_argument("--out", required=True, help="merged output JSONL")
    ap.add_argument("--src-lang", required=True, help="source language code (CSV column 1)")
    ap.add_argument("--tgt-lang", required=True, help="target language code (CSV column 2)")
    ap.add_argument("--delimiter", default=",",
                    help="CSV field delimiter (e.g. '|' for pipe-delimited files)")
    args = ap.parse_args()

    json_path, csv_path, out_path = Path(args.json), Path(args.csv), Path(args.out)
    src_lang, tgt_lang = args.src_lang, args.tgt_lang

    examples = load_jsonl(json_path)
    print(f"Loaded {len(examples):,} existing examples from {json_path.name}")

    pairs = load_csv_pairs(csv_path, args.delimiter)
    print(f"Loaded {len(pairs):,} sentence pairs from {csv_path.name}")

    for src_text, tgt_text in pairs:
        examples.append(make_example(src_lang, tgt_lang, src_text, tgt_text))
        examples.append(make_example(tgt_lang, src_lang, tgt_text, src_text))
    print(f"Combined total before dedup: {len(examples):,}")

    seen = set()
    deduped = []
    for ex in examples:
        key = example_key(ex)
        if key not in seen:
            seen.add(key)
            deduped.append(ex)
    removed = len(examples) - len(deduped)
    print(f"Removed {removed:,} duplicate example(s)")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8", newline="\n") as f:
        for ex in deduped:
            f.write(json.dumps(ex, ensure_ascii=False, separators=(",", ":")))
            f.write("\n")
    print(f"Wrote {len(deduped):,} examples to {out_path}")


if __name__ == "__main__":
    main()
