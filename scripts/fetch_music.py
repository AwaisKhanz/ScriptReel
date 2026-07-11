#!/usr/bin/env python3
"""Download the CC BY 4.0 music library into assets/music/.

The tracks are Kevin MacLeod instrumentals from incompetech.com (the original
FreePD CC0 mirror is defunct). Files are large + third-party, so they are NOT
committed (see .gitignore); this reproduces them from assets/music/manifest.json.

Usage:  python scripts/fetch_music.py [--force]
Attribution is required — see assets/music/CREDITS.md.
"""

from __future__ import annotations

import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MUSIC_DIR = ROOT / "assets" / "music"
BASE = "https://incompetech.com/music/royalty-free/mp3-royaltyfree"


def main() -> int:
    force = "--force" in sys.argv
    manifest = json.loads((MUSIC_DIR / "manifest.json").read_text())
    tracks = manifest["tracks"]
    MUSIC_DIR.mkdir(parents=True, exist_ok=True)

    ok, skipped, failed = 0, 0, 0
    for t in tracks:
        out = ROOT / t["path"]
        if out.exists() and out.stat().st_size > 0 and not force:
            print(f"  skip   {t['id']} (already present)")
            skipped += 1
            continue
        url = f"{BASE}/{urllib.parse.quote(t['sourceTitle'])}.mp3"
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "ScriptReel/fetch_music"})
            with urllib.request.urlopen(req, timeout=120) as resp:
                data = resp.read()
            ctype = resp.headers.get("Content-Type", "")
            if "audio" not in ctype and not data[:3] == b"ID3" and not data[:2] == b"\xff\xfb":
                raise ValueError(f"unexpected content-type {ctype!r}")
            out.write_bytes(data)
            print(f"  ok     {t['id']:20} {len(data) // 1024:>6} KB  ({t['title']})")
            ok += 1
        except Exception as exc:  # noqa: BLE001 — report and continue
            print(f"  FAIL   {t['id']:20} {url}\n         {exc}", file=sys.stderr)
            failed += 1

    print(f"\n{ok} downloaded, {skipped} skipped, {failed} failed → {MUSIC_DIR}")
    if failed:
        print("Some tracks failed. Titles may have changed on incompetech.com; "
              "update sourceTitle in assets/music/manifest.json.", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
