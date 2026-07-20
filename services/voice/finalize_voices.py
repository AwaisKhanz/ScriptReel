"""Lock in the user's 4 chosen voices as clean 24 kHz mono reference clips in voices/.
USAMA + Awais were auditioned as 16 kHz probes; re-extract the SAME 15 s segment at 24 kHz from the
source LibriVox MP3 so Chatterbox clones them at full fidelity (same voice, higher quality).
Noman (ref_1) and Adeel (ref_8) are already 24 kHz and are left as-is.
"""

from __future__ import annotations

import json
import subprocess
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).parent
VOICES = HERE / "voices"
VOICES.mkdir(exist_ok=True)
FF = "C:/Users/GNG/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-8.1.2-full_build/bin/ffmpeg.exe"

# id -> (source identifier, ss seconds) — same 60s offset the probe used, so it's the audio they heard.
REEXTRACT = {
    "usama": ("aeroplanesanddirigibles_1308_librivox", 60),
    "awais": ("ahistoryofthepapacyfromthegreatschismto_2402_librivox", 60),
}


def first_mp3(idf: str) -> str | None:
    with urllib.request.urlopen(f"https://archive.org/metadata/{idf}", timeout=25) as r:
        meta = json.load(r)
    for f in meta.get("files", []):
        if f.get("name", "").lower().endswith(".mp3"):
            return f"https://archive.org/download/{idf}/{urllib.parse.quote(f['name'])}"
    return None


for vid, (idf, ss) in REEXTRACT.items():
    mp3 = first_mp3(idf)
    if not mp3:
        print(f"  {vid}: NO mp3 for {idf}")
        continue
    out = VOICES / f"{vid}.wav"
    subprocess.run(
        [FF, "-y", "-loglevel", "error", "-ss", str(ss), "-t", "15", "-i", mp3,
         "-ac", "1", "-ar", "24000", "-af", "loudnorm", str(out)],
        check=True, timeout=120,
    )
    print(f"  {vid}.wav <- {idf} (24 kHz)")

print("\nfinal reference set:")
for vid in ("usama", "awais", "noman", "adeel"):
    p = VOICES / f"{vid}.wav"
    print(f"  {vid}: {'ok' if p.exists() else 'MISSING'}")
