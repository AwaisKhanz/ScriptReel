# 08 — Media Search

## Provider interface (`packages/core/src/providers.ts`)

```ts
interface MediaProvider {
  id: 'pexels' | 'pixabay';
  search(q: SearchQuery): Promise<RawCandidate[]>;   // one HTTP request max
}
type SearchQuery = { query: string; kind: 'video'|'image'; orientation: 'landscape'|'portrait'|'square'; perPage: number };
type RawCandidate = { provider; providerId; kind; width; height; duration?; thumbUrl; downloadUrl; pageUrl; author; license; meta };
```

All calls go through `QuotaGuard` then `SearchCache`. **No code path may hit a provider directly.**

## Pexels (videos + photos)

- Endpoints: `GET https://api.pexels.com/videos/search` and `https://api.pexels.com/v1/search`; header `Authorization: {PEXELS_API_KEY}`; params `query, orientation, per_page` (max 80; we use 20 video / 15 photo), `size=medium` for videos.
- Candidate mapping: videos → pick `video_files` entry closest-above target height (720 for Draft-first fetch is not allowed — always fetch the file ≥ final height, 1080/1920 per aspect; fall back to largest); `thumbUrl` from `video_pictures[0]` or the `image` field. Photos → `src.large2x` as download, `src.medium` as thumb.
- Quota: **200/hour, 20,000/month** (verified 2026-07). Track both windows in `provider_usage` (hour buckets + month bucket). Headers `X-Ratelimit-Remaining/Reset` reconcile our counter when present.
- Terms honored: display author + Pexels link in UI candidate drawer and credits.txt; cache responses; later, apply for the free unlimited tier with attribution screenshots (noted in doc 22).

## Pixabay (videos + images + illustrations)

- Endpoints: `GET https://pixabay.com/api/videos/?key=…&q=…&per_page=20&safesearch=true` and `https://pixabay.com/api/?key=…&q=…&orientation={horizontal|vertical}&image_type=photo&per_page=15&safesearch=true`. Video endpoint has no orientation param → filter by w/h after.
- Candidate mapping: videos → `videos.large` if ≥ target height else `medium`; thumb: use the per-size `thumbnail` field if present in the response, else **extract frame 0 of the `tiny` variant via ffmpeg** into the thumb cache (robust to API shape changes). Images → `largeImageURL` download, `webformatURL` thumb.
- Quota: **100 requests / 60 s**; responses **must be cached 24 h** (their requirement, and ours anyway). Show "via Pixabay" + author in UI. Download assets locally — never hotlink into renders (we never do; doc 03 invariant).

## SearchCache

Key = `sha1(provider + kind + orientation + normalize(query))`, `normalize` = lowercase, trim, collapse spaces. Value = raw candidate list JSON at `cache/search/{provider}/{key}.json` with `fetchedAt`. TTL 24 h (config `SEARCH_CACHE_TTL_H`). Cache hits cost zero quota — this makes storyboard re-search and pipeline re-runs nearly free.

## QuotaGuard

Durable token accounting in `provider_usage` (doc 05): before each real request, `insert … on conflict do update requests = requests+1 returning requests` for the active window(s); if over budget → wait until window rollover (pixabay: ≤ 60 s, fine) or, for Pexels hour/month exhaustion, raise `E_QUOTA_PEXELS` which the score stage treats as "escalation unavailable" (ladder continues without new searches) and the search stage treats as retry-after-reset only if *zero* candidates exist. Budgets and reserve amounts in doc 22.

## What the search stage actually requests (tier 1 only)

Per beat, from the analysis `queries`:

| mediaPreference | Requests fired |
|---|---|
| mixed (default) | `literal[0]` → Pexels **video**; `literal[1]` → Pixabay **video**; `literal[0]` → Pixabay **image** |
| videos only | `literal[0]` → Pexels video; `literal[1]` → Pixabay video |
| photos allowed | as mixed + `literal[1]` → Pexels **photo** |

Orientation from aspect (16:9→landscape, 9:16→portrait, 1:1→square for images / post-filter ~square for videos with tolerance ±20%). Dedupe: identical normalized query+provider+kind across beats fires once (cache serves the rest). Tiers 2–3 (`conceptual`, `mood`) are fired **only** by the score stage's fallback ladder (doc 09) for beats that need escalation.

Typical video (≈45 beats, mixed): ~45 Pexels + ~90 Pixabay tier-1 requests before dedupe; Pixabay's per-minute window means search paces itself (QuotaGuard sleeps between bursts). Full math + worst cases: doc 22.

## Thumbnail pipeline (input to scoring)

After search, download every candidate's thumb (max 4 parallel) → `cache/thumbs/{provider}/{id}.jpg`, then `sharp` resize to 384px max side (SigLIP input efficiency). Failures: drop the candidate, log. Store `thumb_path` on the candidate row.

## Candidate hygiene at ingest

Drop: duration < 2 s videos; resolution below 60% of target height; extreme aspect mismatch (>2.5× off after crop math); Pixabay `illustration` kind unless mediaPreference allows photos (illustrations often clash tonally — keep them, tagged, but scored with a −0.05 prior). Cap stored candidates at 40/beat by provider order.

## Credits

`compose` writes `credits.txt`: one line per used asset — `#{beatIdx}: {kind} by {author} via {Provider} — {pageUrl}` plus music track credit and "Voice: Kokoro-82M (Apache-2.0)". The storyboard drawer shows author + provider under every thumbnail (satisfies both providers' display expectations).
