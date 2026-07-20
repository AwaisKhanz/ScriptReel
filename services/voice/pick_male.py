"""Download a 15s clip from each candidate LibriVox recording, measure its pitch, and keep the 10
deepest CLEARLY-MALE voices as ref_1..10.wav (sorted deepest first). Male voices sit well below
female ones (median F0 < ~160 Hz), so this guarantees all-male without anyone having to listen.
"""

from __future__ import annotations

import json
import subprocess
import urllib.parse
import urllib.request
from pathlib import Path

import librosa
import numpy as np

OUT = Path("samples")
OUT.mkdir(exist_ok=True)
FF = "C:/Users/GNG/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-8.1.2-full_build/bin/ffmpeg.exe"

CANDIDATES = [
    "1001_questions_history_2004_librivox", "Decline_and_Fall6_0812_librivox1",
    "a_history_of_california_the_spanish_period_1904_librivox",
    "a_history_of_freedom_of_thought_2112_librivox",
    "a_history_of_our_own_times_vol_ii_1907_librivox",
    "a_history_of_the_papacy_volume_i_2308_librivox", "a_lincoln_conscript_2104_librivox",
    "a_short_history_of_france_2111_librivox", "a_soldier_of_the_legion_1702_librivox",
    "a_soldiers_diary_2110_librivox", "abraham_lincoln_2010_librivox",
    "abraham_lincoln_a_history_3_1607_librivox", "abraham_lincoln_a_history_9_1804_librivox",
    "abraham_lincoln_history_2_1603_librivox", "abraham_lincoln_history_4_1701_librivox",
    "abraham_lincoln_history_5_1703_librivox", "abraham_lincoln_history_6_1707_librivox",
    "abraham_lincoln_history_7_1710_librivox", "abraham_lincoln_history_8_1712_librivox",
    "aboriginal_canada", "a_short_history_of_france_2111_librivox",
    "19scifistories_2009_librivox", "20shortsfstories_1908_librivox",
    "3sf_stories_by_frank_herbert_1707_librivox", "5storiesbymackreynolds_1410_librivox",
]


def first_mp3(idf: str) -> str | None:
    with urllib.request.urlopen(f"https://archive.org/metadata/{idf}", timeout=25) as r:
        meta = json.load(r)
    for f in meta.get("files", []):
        if f.get("name", "").lower().endswith(".mp3"):
            return f"https://archive.org/download/{idf}/{urllib.parse.quote(f['name'])}"
    return None


def median_f0(wav: Path) -> tuple[float, float]:
    """Return (median F0 Hz over voiced frames, voiced fraction)."""
    y, sr = librosa.load(str(wav), sr=16000, mono=True)
    f0, voiced, _ = librosa.pyin(y, fmin=70, fmax=320, sr=sr, frame_length=2048)
    vf = float(np.mean(voiced)) if voiced is not None else 0.0
    med = float(np.nanmedian(f0)) if np.any(~np.isnan(f0)) else 999.0
    return med, vf


results: list[tuple[float, Path, str]] = []
seen = set()
for idf in CANDIDATES:
    if idf in seen:
        continue
    seen.add(idf)
    try:
        mp3 = first_mp3(idf)
        if not mp3:
            continue
        tmp = OUT / "_probe.wav"
        subprocess.run(
            [FF, "-y", "-loglevel", "error", "-ss", "55", "-t", "15", "-i", mp3,
             "-ac", "1", "-ar", "24000", "-af", "loudnorm", str(tmp)],
            check=True, timeout=90,
        )
        med, vf = median_f0(tmp)
        male = med < 165 and vf > 0.25
        tag = "MALE  " if male else "female"
        print(f"  {tag} F0={med:5.0f}Hz voiced={vf:.0%}  {idf[:44]}")
        if male:
            keep = OUT / f"cand_{len(results)}.wav"
            tmp.rename(keep)
            results.append((med, keep, idf))
    except Exception as e:  # noqa: BLE001
        print(f"  skip {idf[:40]}: {str(e)[:50]}")
    if len(results) >= 14:
        break

# Keep the 10 deepest (lowest F0) → ref_1..10, deepest first.
results.sort(key=lambda r: r[0])
kept = results[:10]
for f in OUT.glob("cand_*.wav"):
    if f not in [k[1] for k in kept]:
        f.unlink(missing_ok=True)
print(f"\n  kept {len(kept)} male voices (deepest first):")
for i, (med, path, idf) in enumerate(kept, start=1):
    ref = OUT / f"ref_{i}.wav"
    path.rename(ref)
    print(f"   ref_{i}: F0={med:.0f}Hz  from {idf[:40]}")
