#!/usr/bin/env python3
"""
Retroactively score all memories that have only implicit quality scores.

Reads every memory where quality_provider is 'implicit' or 'implicit_signals',
runs the heuristic scorer on the content, and writes the real score back.
Consolidation can then use actual content quality for promotion/decay decisions.

Usage (run from repo root with venv active, .env loaded):
    python scripts/maintenance/rescore_implicit_memories.py [--dry-run]
"""

import asyncio
import argparse
import os
import sys
from pathlib import Path

# Load .env if present (for standalone use on the server)
env_file = Path(__file__).parent.parent.parent / ".env"
if env_file.exists():
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, _, v = line.partition("=")
            os.environ.setdefault(k.strip(), v.strip())

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "src"))

from mcp_memory_service.config.storage import SQLITE_VEC_PATH
from mcp_memory_service.storage.factory import create_storage_instance
from mcp_memory_service.quality.heuristic_scorer import score_content

IMPLICIT_PROVIDERS = {"implicit", "implicit_signals", "onnx_local"}


async def rescore(dry_run: bool) -> None:
    if not SQLITE_VEC_PATH:
        print("ERROR: SQLITE_VEC_PATH not configured. Check MCP_MEMORY_STORAGE_BACKEND in .env")
        sys.exit(1)

    print(f"DB: {SQLITE_VEC_PATH}")
    storage = await create_storage_instance(SQLITE_VEC_PATH, server_type="http")

    print("Fetching all memories...")
    all_memories = await storage.get_all_memories(limit=None)
    print(f"Total memories in DB: {len(all_memories)}")

    targets = [
        m for m in all_memories
        if m.metadata.get("quality_provider", "implicit") in IMPLICIT_PROVIDERS
    ]
    already_scored = len(all_memories) - len(targets)
    print(f"Already have real quality scores: {already_scored}")
    print(f"Will rescore (implicit/implicit_signals): {len(targets)}")

    if not targets:
        print("Nothing to rescore.")
        return

    # Always show score distribution preview
    buckets = {"<0.10 (junk)": 0, "0.10-0.25 (noise)": 0, "0.25-0.50 (low)": 0,
               "0.50-0.75 (medium)": 0, "0.75+ (high)": 0}
    for m in targets:
        s = score_content(m.content)
        if s < 0.10:
            buckets["<0.10 (junk)"] += 1
        elif s < 0.25:
            buckets["0.10-0.25 (noise)"] += 1
        elif s < 0.50:
            buckets["0.25-0.50 (low)"] += 1
        elif s < 0.75:
            buckets["0.50-0.75 (medium)"] += 1
        else:
            buckets["0.75+ (high)"] += 1

    print("\nScore distribution preview:")
    for bucket, count in buckets.items():
        pct = count / len(targets) * 100
        bar = "█" * (count // 20)
        print(f"  {bucket:22s}: {count:5d} ({pct:5.1f}%)  {bar}")

    if dry_run:
        print("\n--dry-run: no writes made.")
        return

    print(f"\nWriting scores back...")
    updated = skipped = errors = 0

    for i, m in enumerate(targets):
        try:
            score = score_content(m.content)
            success, msg = await storage.update_memory_metadata(
                content_hash=m.content_hash,
                updates={"quality_score": score, "quality_provider": "heuristic"},
                preserve_timestamps=True,
            )
            if success:
                updated += 1
            else:
                skipped += 1
        except Exception as e:
            errors += 1

        if (i + 1) % 100 == 0 or (i + 1) == len(targets):
            print(f"  {i+1}/{len(targets)}  updated={updated} skipped={skipped} errors={errors}", end="\r")

    print(f"\nDone: {updated} updated, {skipped} skipped, {errors} errors.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="Preview distribution, no writes")
    args = parser.parse_args()
    asyncio.run(rescore(dry_run=args.dry_run))


if __name__ == "__main__":
    main()
