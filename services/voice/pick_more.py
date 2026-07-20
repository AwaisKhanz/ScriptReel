"""Probe a fresh pool of LibriVox recordings, measure each voice's pitch, and select:
  - 6 new MALE voices in the same register as the user's keepers ref_1 (107 Hz) & ref_8 (123 Hz)
  - 4 mature FEMALE voices (warm, not girlish)
Males  -> ref_11..16.wav   Females -> ref_f1..f4.wav
Keepers ref_1.wav / ref_8.wav are never touched. Titles only bias the pool; the measured F0 is
the truth, so a male reader hiding in the "female" list (or vice-versa) is routed correctly.
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

# Fresh, non-overlapping candidates (title-biased pools; F0 decides the actual bucket).
MALE_POOL = [
    "3sfstoriesbywilliamtenn_1910_librivox", "adiscourseonprayer_2511_librivox",
    "advance_science_jms_librivox", "adventuresmanofscience_2401_librivox",
    "advice_to_young_men_and_boys_2311_librivox", "aeroplanesanddirigibles_1308_librivox",
    "ahistoryofthepapacyfromthegreatschismto_2402_librivox",
    "ahistoryofthepapacyviii_2409_librivox",
    "ahistoryofwitchcraftinenglandfrom1558to_2411_librivox",
    "alifeofnapoleon_2601_librivox", "american_civil_war_collection_vol1_1410_librivox",
    "american_history_stories_vol2_0901_librivox", "american_notes_1108_librivox",
    "3storiesbygeraldvance_1409_librivox", "airshipboys_2108_librivox",
    "alabamastudent_1610_librivox",
]
FEMALE_POOL = [
    "0_sense_and_sensibility_librivox", "4storiesbylouisamayalcott_1608_librivox",
    "a_lost_lady_1901_librivox", "a_womans_journey_round_the_world_1406_librivox",
    "a_womans_love_letters_1702_librivox", "a_womans_way_through_unknown_labrador_2101_librivox",
    "a_wonder_book_vers_2_1810_librivox", "a_world_of_girls_2206_librivox",
    "a_young_girls_diary_1504_librivox", "adventures_mrsseacole_1407_librivox",
    "adventures_of_an_ugly_girl_1910_librivox", "alostlady_2009_librivox",
    "amazons_1108_librivox", "anglo-american_alliance_2202_librivox",
    "ageofanne_2010_librivox", "agincourt_2210_librivox",
]


def first_mp3(idf: str) -> str | None:
    with urllib.request.urlopen(f"https://archive.org/metadata/{idf}", timeout=25) as r:
        meta = json.load(r)
    for f in meta.get("files", []):
        if f.get("name", "").lower().endswith(".mp3"):
            return f"https://archive.org/download/{idf}/{urllib.parse.quote(f['name'])}"
    return None


def probe(idf: str) -> tuple[float, float] | None:
    """Download 15s past the intro, return (median F0 Hz, voiced fraction) or None on failure."""
    mp3 = first_mp3(idf)
    if not mp3:
        return None
    tmp = OUT / "_probe.wav"
    subprocess.run(
        [FF, "-y", "-loglevel", "error", "-ss", "60", "-t", "15", "-i", mp3,
         "-ac", "1", "-ar", "16000", "-af", "loudnorm", str(tmp)],
        check=True, timeout=90,
    )
    y, sr = librosa.load(str(tmp), sr=16000, mono=True)
    f0, voiced, _ = librosa.pyin(y, fmin=70, fmax=320, sr=sr, frame_length=2048)
    vf = float(np.mean(voiced)) if voiced is not None else 0.0
    med = float(np.nanmedian(f0)) if np.any(~np.isnan(f0)) else 999.0
    tmp.rename(OUT / f"probe_{idf[:30]}.wav")
    return med, vf


males: list[tuple[float, str]] = []   # (F0, identifier), for ref_11..
females: list[tuple[float, str]] = []  # (F0, identifier), for ref_f1..

for pool, want_male in ((MALE_POOL, True), (FEMALE_POOL, False)):
    for idf in pool:
        try:
            r = probe(idf)
            if r is None:
                print(f"  no-mp3 {idf[:40]}")
                continue
            med, vf = r
            if vf < 0.30:
                print(f"  weak   F0={med:5.0f}Hz voiced={vf:.0%}  {idf[:38]} (too little voiced speech)")
                continue
            # Male like keepers: 100-140 Hz. Mature female: 160-215 Hz (skip girlish >215).
            if 100 <= med <= 140:
                males.append((med, idf))
                print(f"  MALE   F0={med:5.0f}Hz voiced={vf:.0%}  {idf[:38]}")
            elif 158 <= med <= 215:
                females.append((med, idf))
                print(f"  FEMALE F0={med:5.0f}Hz voiced={vf:.0%}  {idf[:38]}")
            else:
                print(f"  skip   F0={med:5.0f}Hz voiced={vf:.0%}  {idf[:38]} (out of target range)")
        except Exception as e:  # noqa: BLE001
            print(f"  fail   {idf[:38]}: {str(e)[:45]}")

# Males closest to the keepers' register (107-123 Hz) first.
males.sort(key=lambda m: abs(m[0] - 115))
# Mature females: lower (warmer) first.
females.sort(key=lambda f: f[0])

pick_m = males[:6]
pick_f = females[:4]
print(f"\n  selected {len(pick_m)} males + {len(pick_f)} females")

for i, (med, idf) in enumerate(pick_m, start=11):
    src = OUT / f"probe_{idf[:30]}.wav"
    if src.exists():
        src.rename(OUT / f"ref_{i}.wav")
        print(f"   ref_{i}:  F0={med:.0f}Hz  {idf[:40]}")
for i, (med, idf) in enumerate(pick_f, start=1):
    src = OUT / f"probe_{idf[:30]}.wav"
    if src.exists():
        src.rename(OUT / f"ref_f{i}.wav")
        print(f"   ref_f{i}: F0={med:.0f}Hz  {idf[:40]}")

# Clean up unused probes.
for p in OUT.glob("probe_*.wav"):
    p.unlink(missing_ok=True)
print("\ndone — run clone_variants.py to render the health script on each.")
