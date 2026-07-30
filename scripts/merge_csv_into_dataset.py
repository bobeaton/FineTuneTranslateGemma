"""Merge additional Hindi-Kangri sentence pairs from a CSV file into an existing
TranslateGemma fine-tuning dataset (JSONL) and write the combined, de-duplicated
result to a new file.

The JSONL format matches what TranslateGemmaData.TranslationDataset (C#) writes:
one compact JSON object per line:

  {"messages":[
     {"role":"user","content":[{"type":"text","source_lang_code":"hi",
                                "target_lang_code":"xnr","text":"<source>"}]},
     {"role":"assistant","content":[{"type":"text","text":"<target>"}]}]}

Each CSV row (Hindi in column 1, Kangri in column 2) is emitted in BOTH
directions (hi->xnr and xnr->hi), matching the existing data. Duplicates are
removed across the whole combined set using the same key the C# Deduplicate()
uses: (source_lang, target_lang, source_text, target_text), keeping the first
occurrence.

Output is UTF-8 without BOM, "\n" line endings, un-escaped Devanagari.

Usage (defaults match Bob's file locations):
  python scripts/merge_csv_into_dataset.py
  python scripts/merge_csv_into_dataset.py --json IN.json --csv NEW.csv --out OUT.json
"""

import argparse
import csv
import json
import sys
from pathlib import Path

DEFAULT_JSON = r"C:\Users\pete_\Dropbox\NTprogress\TranslateGemma\GemmaDataSet_HIN_XNR_NT.json"
DEFAULT_CSV = r"C:\Users\pete_\Dropbox\NTprogress\Bible Studies\Addl Hindi-Kangri Couplets (spellfix).csv"
DEFAULT_OUT = r"C:\Users\pete_\Dropbox\NTprogress\TranslateGemma\GemmaDataSet_HIN_XNR_Total.json"

HI = "hi"
XNR = "xnr"


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


def load_csv_pairs(path: Path) -> list:
    """Return [(hindi, kangri), ...] from the CSV, skipping the header row and
    any row without both columns filled."""
    pairs = []
    skipped = 0
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.reader(f)
        header = next(reader, None)  # "Hindi,Kangri"
        if header:
            print(f"CSV header: {header}")
        for row in reader:
            if len(row) < 2:
                skipped += 1
                continue
            hindi, kangri = row[0].strip(), row[1].strip()
            if not hindi or not kangri:
                skipped += 1
                continue
            pairs.append((hindi, kangri))
    if skipped:
        print(f"Skipped {skipped} CSV row(s) with missing Hindi or Kangri text.")
    return pairs


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--json", default=DEFAULT_JSON, help="existing JSONL dataset")
    ap.add_argument("--csv", default=DEFAULT_CSV, help="CSV with Hindi,Kangri columns")
    ap.add_argument("--out", default=DEFAULT_OUT, help="merged output JSONL")
    args = ap.parse_args()

    json_path, csv_path, out_path = Path(args.json), Path(args.csv), Path(args.out)

    examples = load_jsonl(json_path)
    print(f"Loaded {len(examples):,} existing examples from {json_path.name}")

    pairs = load_csv_pairs(csv_path)
    print(f"Loaded {len(pairs):,} sentence pairs from {csv_path.name}")

    for hindi, kangri in pairs:
        examples.append(make_example(HI, XNR, hindi, kangri))
        examples.append(make_example(XNR, HI, kangri, hindi))
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
