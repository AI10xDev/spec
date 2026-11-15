#!/usr/bin/env python3
"""Download pinned public SWE-bench Lite data; never execute dataset content."""
import hashlib
import io
import json
from pathlib import Path
import urllib.request

REVISION = "6ec7bb89b9342f664a54a6e0a6ea6501d3437cc2"
URL = f"https://huggingface.co/datasets/princeton-nlp/SWE-bench_Lite/resolve/{REVISION}/data/test-00000-of-00001.parquet"
DESTINATION = Path(__file__).resolve().parents[1] / "workspace" / "swe-bench"
COLUMNS = ["instance_id", "repo", "base_commit", "problem_statement"]


def select(rows, count=15):
    """Longest UTF-8 description per repo, then longest remaining; ID breaks ties."""
    ranked = sorted(rows, key=lambda row: (-len(row["problem_statement"].encode()), row["instance_id"]))
    chosen = {}
    repos = set()
    for row in ranked:
        if row["repo"] not in repos:
            chosen[row["instance_id"]] = row
            repos.add(row["repo"])
    if count < len(chosen):
        raise ValueError("count must cover every repository")
    for row in ranked:
        if len(chosen) >= count:
            break
        chosen[row["instance_id"]] = row
    return sorted(chosen.values(), key=lambda row: row["instance_id"])


def main():
    import pyarrow.parquet as parquet

    with urllib.request.urlopen(URL, timeout=60) as response:
        data = response.read(8 * 1024 * 1024 + 1)
    if len(data) > 8 * 1024 * 1024:
        raise ValueError("Dataset exceeded 8 MiB download budget")
    if hashlib.sha256(data).hexdigest() != "7a21f37b8bc179c7db5beeb14e88ac538ba283455c776e6b2535bbfb6e3551b4":
        raise ValueError("Pinned dataset checksum mismatch")
    # Read only task inputs: gold patches, test patches and hints are not exported.
    rows = parquet.read_table(io.BytesIO(data), columns=COLUMNS).to_pylist()
    if len(rows) != 300 or len({row["instance_id"] for row in rows}) != 300:
        raise ValueError("Expected 300 unique test instances")
    for row in rows:
        if not all(isinstance(row[key], str) and row[key] for key in COLUMNS):
            raise ValueError("Invalid task input")
    selected = select(rows)
    for row in selected:
        row["bytes"] = len(row["problem_statement"].encode())
        row["sha256"] = hashlib.sha256(row["problem_statement"].encode()).hexdigest()
    manifest = {
        "dataset": "princeton-nlp/SWE-bench_Lite", "revision": REVISION,
        "split": "test", "url": URL, "download_bytes": len(data),
        "parquet_sha256": hashlib.sha256(data).hexdigest(), "population": len(rows),
        "selection": "Longest UTF-8 problem_statement per repository, then longest remaining to 15; ties by instance_id; final order by instance_id",
        "scope": "UI/local fixture stress only; SWE-bench resolved-rate NOT MEASURED",
        "instances": selected,
    }
    DESTINATION.mkdir(parents=True, exist_ok=True)
    (DESTINATION / "test.parquet").write_bytes(data)
    (DESTINATION / "subset.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps({key: value for key, value in manifest.items() if key != "instances"}, indent=2))
    print(json.dumps([{key: row[key] for key in ("instance_id", "repo", "bytes", "sha256")} for row in selected], indent=2))


if __name__ == "__main__":
    main()
