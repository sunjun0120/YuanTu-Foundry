"""Export the pinned test split. Temporary venv requirements: datasets==5.1.0.

Usage: python fetch-dataset.py --revision <40-char HF commit> --out <new.jsonl>
Never pass main: subset-v1.json must bind the immutable Hub revision.
"""

import argparse
import json
import re
from pathlib import Path

from datasets import load_dataset


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    if not re.fullmatch(r"[a-f0-9]{40}", args.revision):
        parser.error("revision must be a full Hugging Face commit SHA")
    dataset = load_dataset(
        "SWE-bench/SWE-bench_Verified", revision=args.revision, split="test"
    )
    if len(dataset) != 500:
        raise ValueError("Expected 500 Verified test instances")
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("x", encoding="utf-8", newline="\n") as output:
        for record in sorted(dataset, key=lambda row: row["instance_id"]):
            output.write(json.dumps(record, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n")
    print(f"Exported {len(dataset)} instances at {args.revision}")


if __name__ == "__main__":
    main()
