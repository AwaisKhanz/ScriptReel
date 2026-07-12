# 24 — Entity-Driven Visual Intelligence

Extends doc 07 (script analysis), doc 08 (media search), doc 09 (matching), doc 23 (expanded
sourcing). Goal: the engine must **understand each beat before it searches** — extract the real
entities, classify them, and resolve them to *authoritative* imagery (the actual Dead Sea, the real
flag, the NASA photo of Pluto) instead of guessing keywords against generic stock. The output should
read like a premium documentary (MagnatesMedia / Johnny Harris), not a stock slideshow. Free, no
local models (OpenAI GPT only). Owner directive 2026-07-12.

## 1. The reframe — understanding precedes searching

Today's path is `phrase → search stock → pick by SigLIP`. The word "Dead Sea" competes with every
blue-water clip because **nothing ever resolves the *name* to the *thing*.** That is the ceiling of
keyword sourcing, not a bug in it.

New order — searching is the **last** step, not the first:

```
beat → understand (LLM) → typed entities → visual plan (shots) →
  resolve entities to authoritative assets → search fills the gaps →
  validate (vision + SigLIP) → score → mix images + video → timeline
```

Invariant added: **a beat's visuals are planned from its meaning, then sourced — never sourced then
rationalized.** The LLM already runs in `analyze`; this reuses that one call for the understanding
step, so there is no new model and nothing local.

## 2. The entity model (analyze)

`analyze` today emits a flat `entities: { people, places, objects }` of bare strings — no type, no
routing signal (`packages/core/src/analysis.ts`, `BeatSchema`). Replace it with a **typed** entity
list (pure zod in core; filled by the existing OpenAI call in `openai-analyzer.ts`):

```ts
EntityCategory =
  | Person | Country | Region | City | Landmark | Lake | Ocean | Mountain | River
  | Nature | Animal | Planet | Astro | Building | Vehicle | Company | Brand
  | Product | Software | Artwork | Book | Film | Event | Concept | Object | Symbol | Flag   // extensible

Entity = {
  surface: string           // as written in the narration ("the Dead Sea")
  canonical: string         // disambiguated English name ("Dead Sea")
  category: EntityCategory
  instanceOf: string        // expected Wikidata class label ("lake") — used to VERIFY the hit (§4)
  disambiguation?: string   // one-line sense hint ("the salt lake, not the band")
  searchTerms: string[]     // English fallback queries for stock / Commons text search
  visualizable: boolean     // false ⇒ abstract ⇒ generic b-roll or text card
}
```

Prompt rules (doc 07 extension):

- Emit entities **only** for concrete, on-screen things; skip pronouns, function words, and
  non-visual abstractions (mark those `visualizable: false`).
- **Never emit a Wikidata Q-id.** The model hallucinates them confidently and they are unverifiable
  by eye; we resolve and verify the id ourselves (§4). The model's job is name + category +
  `instanceOf` + hint + search terms.
- Disambiguate from sentence context ("Jordan" the country vs. the given name vs. the river).
- English always (invariant), regardless of script language.

## 3. The visual plan (per-beat shot list)

`visualMoments[]` (doc 23 §7b) graduates into a **typed shot plan** — the ordered shots that tell the
beat's story, each bound to an entity and a source intent:

```ts
ShotWant = portrait | flag | map | aerial | logo | footage | scene | generic
Shot = {
  phrase: string            // searchable English phrase ("dead sea aerial view")
  entity: string            // canonical of the depicted entity ('' = generic mood shot); a stable
                            //   key (survives beat merge/dedupe) — not a fragile array index
  want: ShotWant            // what KIND of asset this shot needs — turns a category into the right file
  weight: number            // relative on-screen time (feeds splitSegmentFrames, doc 23 §7)
}
```

`want` is what turns a *category* into the *right kind* of asset — a Country's `flag` shot vs. its
`map` shot vs. its `scene` shot. A beat holds 2–4 shots (cap unchanged); a truly single-image beat
stays one shot. **Backward-compatible:** `visualMoments` is derivable as `shots.map(s => s.phrase)`,
so the existing search / score / montage paths keep working while they are upgraded rung by rung.

Worked example — *"The Dead Sea, located between Jordan and Israel"*:

- entities: `[{Dead Sea, Lake, instanceOf: lake}, {Jordan, Country}, {Israel, Country}]`
- shots: `[{dead sea aerial, "Dead Sea", aerial}, {jordan locator map, "Jordan", map}, {israel
  locator map, "Israel", map}, {dead sea salt shore, "Dead Sea", scene}]`

## 4. Entity resolution — Wikidata → Commons (the authoritative muscle)

Worker-side (network I/O ⇒ **not** `packages/core`; invariant 8). Keyless. Behind `QuotaGuard` +
`SearchCache` — for etiquette and reliability, not hard quota. **Wikimedia requires a descriptive
`User-Agent`** (`ScriptReel/1.0 (contact)`), or requests are blocked; this is the most common
silent-failure cause.

Four steps (all verified live against the real APIs):

1. **Name → candidates** — `wbsearchentities?search=<canonical>&language=en&type=item&format=json`
   → ranked `{ id, label, description }` (fuzzy/alias-aware; better than SPARQL exact-label).
2. **Verify sense** — fetch `Special:EntityData/<Qid>.json` and **check `P31` (instance-of) against
   the entity's `instanceOf`** (human = Q5, country = Q6256, planet = Q634, business = Q4830453,
   lake = Q23397 …). Mismatch ⇒ reject, try the next candidate. *This is the single biggest
   correctness lever* — it is what stops "Jordan the person" and "an ocean labelled Dead Sea".
3. **Q-id → asset by `want`** — read the image-bearing Commons-media property:

   | want | Wikidata property |
   |---|---|
   | portrait / scene / aerial | **P18** image (+ **P8592** aerial view, **P948** 16:9 page banner) |
   | flag | **P41** flag image |
   | map | **P242** locator map (a coat of arms is not a map → stock fallback) |
   | logo | **P154** logo *(trademark policy — §7)* |

   Prefer a `rank: "preferred"` claim, else the first value. P18 can be multi-valued.
4. **Commons file → URL + license** — `api.wikimedia.org/core/v1/commons/file/<name>` returns the
   direct `original` / `thumbnail` URL cleanly; `action=query&prop=imageinfo&iiprop=url|extmetadata`
   returns the **license** (`extmetadata.License` machine code) plus attribution (`Artist`,
   `Credit`, `LicenseShortName`). Run the doc 23 §3 license gate on that code — allow PD / CC0 /
   CC-BY; **reject** NC, ND, BY-SA (ShareAlike would infect the output), and unknown/unstated.

**NASA** (`images-api.nasa.gov`, keyless, US public domain) resolves `Planet / Astro / Event` shots:
`search?q=<canonical>&media_type=image|video` → `asset/<nasa_id>` → `<id>~orig.jpg` / `~orig.mp4`.
**Internet Archive** (Phase 24b) resolves `Event` footage. The resolved tuple
`entity + want → { url, license, attribution, provider }` is cached hard — these never change.

> **Honest ceiling.** P18 is editor-chosen and occasionally off-topic (a diagram where you wanted a
> photo); `wbsearchentities` can also link the wrong sense. We already run SigLIP — so §7 verifies
> the fetched asset's cosine against the entity/phrase and falls back to text search or stock when it
> is weak. Resolution *proposes*; validation *disposes*.

## 5. Category → source routing

Search becomes **authoritative-first**, per shot, by category — stock fills gaps or serves
`visualizable: false`. NASA and Wikimedia are already wired providers (doc 23 §4); this drives them by
*entity*, not by the coarse keyword `classifyDomain`.

| Category | Primary (authoritative) | Fallback |
|---|---|---|
| Person | Commons **P18** portrait; IA / NASA archival footage | stock |
| Country / Region | **P41** flag · **P242** locator map · P94 arms | — |
| City / Landmark / Lake / Mountain / River | P18 · **P8592** aerial · **P948** banner · P242 map | stock ambience |
| Planet / Astro | **NASA** images + video · ESA / Hubble | Commons P18 |
| Company / Brand / Product / Software | Commons **P154** logo *(policy §7)* · P18 | press kit / Openverse |
| Historical Event | **Internet Archive** film · LoC photos · NASA | Commons |
| Artwork / Book / Film | Commons P18 · Smithsonian OA (CC0) | — |
| Animal / Nature / Object | Commons P18 | stock |
| **Concept / Emotion** (`visualizable: false`) | *no authoritative image* → stock + SigLIP or text card | — |

The `visualizable` flag is the switch: a concrete entity takes the authoritative ladder; an
abstraction stays on today's stock + SigLIP path (or a text card) rather than being forced into a bad
literal match. Generic mood shots (`entityRef` undefined) go straight to stock. Every request still
round-robins into the 40-candidate pool (doc 23 §7 per-moment search), so the pool stays balanced and
quota-bounded.

## 6. New providers

Same framework as doc 23 §4 — one `MediaProvider` module, a `ProviderId` union member, a
`PROVIDER_WINDOWS` budget, `RawCandidate.license` load-bearing, and download to `asset_cache` (no
hotlinking):

- **`wikidata-commons`** — the §4 resolver as an entity-aware provider (input: entity + want; output:
  curated candidates carrying license + attribution).
- **`internet-archive`** — public-domain historical *video*:
  `advancedsearch.php?q=subject:(…) AND mediatype:movies&fl[]=identifier&fl[]=licenseurl&output=json`
  → `metadata/<id>` → `download/<id>/<file>`. Filter `licenseurl` (reject NC / ND / unknown), cap
  file `size`, and prefer mp4 — files reach 400 MB, so caching is mandatory.
- Follow-ons (24c): **Library of Congress** (`?fo=json` — Cloudflare-gated, low QPS, needs retries +
  a real UA), **Smithsonian Open Access** (free `api.data.gov` key in Settings, CC0 subset only),
  **ESA / Hubble** (CC-BY; mostly reachable through Commons anyway).

## 7. Validation, scoring & policy

- **SigLIP entity-verify** — a fetched authoritative asset must clear a cosine floor `[CALIBRATE]`
  vs. the entity/phrase, else fall back. Catches bad P18 and wrong-sense links (§4 ceiling).
- **Vision fit-check** — keep `apps/worker/src/analysis/media-verifier.ts`, but graduate it from a
  lenient boolean to a small relevance + quality read (depicts the entity? geographically /
  historically right? letterboxed / watermarked / cluttered?) that feeds the score.
- **Documentary asset score** — extend `baseScore` weights (doc 09 / `matching.ts`) with an
  entity-match and an authoritative-provenance bonus, so the *real* subject outranks a prettier
  generic stand-in (doc 23 §6 `acceptTop` already leans this way).
- **Logo / trademark policy** — Commons **P154** logos are frequently non-free or trademarked even
  when PD-for-copyright. Prefer `PD-textlogo`, keep use nominative / editorial, never imply
  endorsement; when in doubt, skip the logo and use HQ or product footage.

## 8. Composition (reuse what already ships)

The montage assembler already exists (doc 23 §7: `planSemanticMontage` / `planMontage` /
`planSameSourceMontage`, image⇄video kind-mix, `splitSegmentFrames`, per-segment motion in-points,
saliency-aware Ken Burns, `concatClips`). The entity plan simply *feeds* it: the authoritative image
is the anchor shot, stock video supplies motion / ambience, and stills get Ken Burns. Narration stays
the clock; `timeline.json` stays the only brain↔renderer contract (invariants 1–2).

> **The one genuinely hard part.** Custom **animated highlighted maps** (fill Jordan red, sweep to
> the Dead Sea) are what is hard without a local renderer. Pragmatic free path: Commons **P242
> locator maps** are *already* highlighted, and a Ken-Burns zoom into the region delivers ~80% of the
> effect at zero cost. A true map-highlight renderer is scoped separately (24c) and is the only place
> the "no local models" constraint actually bites.

## 9. Free & lightweight discipline

- Every source free / keyless or free-key; all behind `QuotaGuard` + 24 h `SearchCache`. Entity→asset
  tuples cache permanently.
- Bounded compute: resolve the top entities per beat, top-K assets per shot, ≤ 5 frames per video,
  reuse the existing SigLIP sidecar. No new model, nothing local.
- **Degrade, never die** (invariant 7): a resolution miss ⇒ Commons/stock text search ⇒ the doc 09
  ladder ⇒ text card. A wrong `instanceOf`, a blocked LoC, a 400 MB IA file — each degrades to the
  next rung; the render always completes.

## 10. Contract changes (summary)

1. `analyze`: `entities` becomes the typed list (§2); the beat gains a `shots[]` plan (§3).
   `visualMoments` stays derivable for back-compat. Zod in `packages/core`; DB `beats.entities`
   reshaped + new `beats.shots` jsonb (nullable).
2. `ProviderId` union += `wikidata-commons`, `internet-archive` (later LoC / Smithsonian);
   `PROVIDER_WINDOWS` budgets added.
3. Search: the category→source router (§5) drives entity shots; the keyword `classifyDomain` fan-out
   stays as the fallback for generic beats.
4. New `entity_resolution` cache (`entity + want → { url, license, attribution }`); extends the
   `asset_cache` discipline (doc 23 §8).
5. `timeline.json` unchanged — it already carries `segments[]` (doc 23 §7).

## 11. Phasing (one slice per session, like the roadmap)

- **24a — Entity brain + Wikidata / NASA resolution.** Typed entities + shot plan in `analyze`; the
  `wikidata-commons` resolver with **P31 verification** + license gate; category routing for Person /
  Country / Place / Planet. *Exit:* on a factual script the real subject appears (Dead Sea, flag,
  locator map, Pluto), license-clean and SigLIP-verified — visibly not generic stock.
- **24b — Archive video + validation hardening.** Internet Archive PD video; SigLIP entity-verify;
  vision fit-check → relevance + quality score; attribution captured in `credits.txt`. *Exit:*
  authentic historical footage where it exists; a measured relevance lift with no license regression.
- **24c — Long tail.** Library of Congress + Smithsonian (Settings key); logo policy; the
  map-highlight renderer; documentary multi-criteria scoring. *Exit:* full source ladder, animated
  maps, and the golden-set rubric beats 24b.

Exit for the initiative: on a documentary-style golden script, **every concrete entity is supported
by an authoritative, license-clean, verified asset**, beats are mixed image+video montages, and a
blind viewer rates the output "documentary," not "stock slideshow" — at no new cost, no local model,
within the existing time budget.
