# 13 — Composition Spec (FFmpeg)

All commands via execa with full arg arrays (never shell strings), stderr captured (last 40 lines into `E_FFMPEG` errors), `-y -hide_banner -loglevel warning -stats`. `W×H` from timeline. Constants here are the spec; put them in `packages/core/src/compose/constants.ts`.

## Pass A — per-beat normalization (fetch stage output, parallelism 3)

Every beat becomes a uniform clip: `W×H`, 30 fps, yuv420p, SAR 1, **no audio**, length `L_i` (padding rules below).

**Video source:**
```
ffmpeg [-stream_loop N] -ss {inPoint} -t {L_i} -i {src}
  -vf "scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},fps=30,setsar=1,format=yuv420p"
  -an -c:v h264_videotoolbox -b:v 14M -allow_sw 1 clips/{idx}.mp4
```
`N = ceil(L_i / srcDur) − 1` when the source is short (loop before trim). If looping would repeat > 3×, prefer hold-last-frame: `tpad=stop_mode=clone:stop_duration={pad}` appended instead of looping.

**Still (image / generated / textcard) → Ken Burns:**
```
ffmpeg -loop 1 -framerate 30 -i {img}
  -vf "scale={2W}:-2,zoompan=z='{zoomExpr}':x='{xExpr}':y='{yExpr}':d={frames}:s={W}x{H}:fps=30,format=yuv420p"
  -t {L_i} -an -c:v h264_videotoolbox -b:v 14M clips/{idx}.mp4
```
Anti-jitter: pre-scale to 2× target before zoompan. `frames = round(L_i·30)`. Zoom expr for `in`: `min({zoomFrom}+({zoomTo}-{zoomFrom})*on/{frames}, {zoomTo})`; `out` reversed. Pan exprs anchor the drift corner: e.g. `in-tl`: `x='(iw-iw/zoom)*0.15'`, `y='(ih-ih/zoom)*0.15'`; `out-tr`: `x='(iw-iw/zoom)*0.85'`, `y='(ih-ih/zoom)*0.15'`; keep drift subtle (fixed anchors, zoom does the motion). Textcards are rendered by the sidecar at 2×W (doc 14) so they survive the zoom crisp.

## xfade timing math (get this exactly right)

Let beats have narration durations `d_1..d_n` (timeline `durationSec`), fade `f` at fading boundaries (0 at `cut` boundaries). Transitions should straddle boundaries symmetrically: the crossfade at boundary `i` occupies `[B_i − f/2, B_i + f/2]` where `B_i = Σ_{j≤i} d_j`.

Clip padded lengths:
```
L_i = d_i + f_left(i)/2 + f_right(i)/2
  f_left(i)  = f if boundary i−1 is crossfade else 0   (f_left(1) = 0)
  f_right(i) = f if boundary i   is crossfade else 0   (f_right(n) = 0)
```
Normalization (Pass A) must therefore know the boundary plan — the timeline builder computes `L_i` and passes it to fetch/normalize. For a video source, the extra head/tail comes from the source around `inPoint` when available, else tpad-clone.

xfade chain offsets (offset = time in the *combined* stream where the fade starts):
```
[0][1] xfade=transition=fade:duration=f:offset=O_1 [v01];
[v01][2] xfade=…:offset=O_2 [v012]; …
O_1 = B_1 − f/2
O_k = B_k − f/2                      (because each fade re-synchronizes total to B_k + f/2)
```
Cut boundaries use `concat` grouping: contiguous cut-joined runs are first concatenated (`concat=n=…:v=1:a=0` or concat demuxer since formats are uniform), producing segment files whose internal boundaries need no padding; xfade then joins segments. Implementation: the compose planner reduces `perBoundary` into an alternating [segment, fade, segment…] plan. **Total duration must equal `Σ d_i` exactly (± 1 frame)** — assert with ffprobe after Pass B.

## Pass B — visual assembly

Single ffmpeg invocation: inputs = segment clips, filter_complex = planned xfade chain → intermediate `video_nosub.mp4` (same codec settings as Pass A). For ≤ 2 boundaries total, collapse Pass B into Pass C directly.

## Pass C — subtitles + audio + final encode

```
ffmpeg -i video_nosub.mp4 -i {vo.wav} [-stream_loop -1 -i {music}]
 -filter_complex "
   [0:v]subtitles={render.ass}:fontsdir={assets/fonts}[v];
   [2:a]atrim=0:{T},volume={pregain}dB,afade=t=out:st={T-fadeOut}:d={fadeOut}[m];
   [m][1:a]sidechaincompress=threshold=0.02:ratio=8:attack=15:release=350:makeup=1[md];
   [md][1:a]amix=inputs=2:duration=first:normalize=0[a]
 "
 -map "[v]" -map "[a]" {ENCODE} -movflags +faststart renders/{rid}/final.mp4
```
- `T` = narration duration; `pregain = music.gainDb` (relative level; VO is already −16 LUFS).
- No music → skip music graph, `-map 1:a` with `aformat`.
- No subtitles → skip subtitles filter.
- Audio out: `-c:a aac -b:a 192k -ar 48000`.

`{ENCODE}` by preset:

| Preset | Args |
|---|---|
| `final` | `-c:v h264_videotoolbox -b:v {10M @1080p / 12M @9:16} -profile:v high -allow_sw 1` |
| `draft` | scale filter to 720-height equivalent first, `-c:v libx264 -preset ultrafast -crf 26` |
| `archival` (flag `FORCE_X264=1`) | `-c:v libx264 -preset slow -crf 18` (quality baseline for A/B against VideoToolbox) |

## Editorial constants (the "feels human" rules — implement, don't debate)

- Crossfade 0.4 s default; never > 0.6 s.
- Music −16 dB under voice pre-duck; ducked further by sidechain during speech; 2 s fade-out ending with narration tail +1.0 s of video hold on the last beat (builder adds 1.0 s tail to `d_n`? No — keep A/V equal length; instead last beat's clip holds while music fades within `T`).
- Beat visual variety enforced upstream (doc 09); composer never reorders.
- Thumbnail: `ffmpeg -ss {T·0.15} -i final.mp4 -frames:v 1 -vf scale=640:-2 thumbnail.jpg`.

## Post-render assertions (compose stage, before marking done)

ffprobe final.mp4: duration = narration ± 0.1 s; streams = 1 video (30 fps, W×H) + 1 audio (48 kHz); size > 0. Write credits.txt (doc 08). Any assertion failure → `E_COMPOSE_VERIFY` with probe dump.
