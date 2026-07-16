'use client';

import {
  isArchiveProvider,
  providerLabel,
  STORYBOARD_CANDIDATES,
  TAU_HI,
  TAU_LO,
} from '@scriptreel/core';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { fileUrl, fmtDuration } from '../lib/format';
import { Badge, Button, Card, Dot, Skeleton, Spinner } from './ui';

export interface Candidate {
  id: string;
  kind: 'video' | 'image' | 'generated' | 'textcard';
  provider: string;
  thumbPath: string | null;
  remoteUrl: string | null;
  duration: number | null;
  author: string | null;
  score: number | null;
  pageUrl: string | null;
  width: number | null;
  height: number | null;
}

// Render fixed overlays on document.body so they escape any transformed ancestor (the
// page uses a fade-up animation, which would otherwise make `position: fixed` resolve
// against the page div instead of the viewport).
function Portal({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted ? createPortal(children, document.body) : null;
}

function PlayBadge({ onClick }: { onClick: (e: React.MouseEvent) => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Play the stitched beat clip"
      className="absolute left-1/2 top-1/2 flex size-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur transition-transform duration-[var(--dur-fast)] hover:scale-105"
    >
      <svg viewBox="0 0 24 24" className="size-5 translate-x-px" fill="currentColor" aria-hidden>
        <path d="M8 5v14l11-7z" />
      </svg>
    </button>
  );
}

export interface Beat {
  id: string;
  idx: number;
  text: string;
  emotion: string | null;
  estSeconds: number | null;
  visualDescription: string | null;
  forcedTextcard: boolean;
  chosenCandidateId: string | null;
  score: number | null;
  // montage sequence (doc 23 §7): the ordered shots stitched into the beat clip
  segments: { candidateId: string; thumbPath: string | null; kind: string }[] | null;
  // rendered combined montage clip — fetch runs before the review gate (doc 24 §8)
  clipUrl: string | null;
  candidates: Candidate[];
}

const ASPECT_THUMB: Record<string, string> = {
  '16:9': 'aspect-video',
  '9:16': 'aspect-[9/16]',
  '1:1': 'aspect-square',
};
const ASPECT_COLS: Record<string, string> = {
  '16:9': 'sm:grid-cols-2 lg:grid-cols-3',
  '9:16': 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-5',
  '1:1': 'sm:grid-cols-2 lg:grid-cols-4',
};

function scoreTone(c: { score: number | null; kind: string }): 'success' | 'warning' | 'neutral' {
  if (c.kind === 'textcard' || c.kind === 'generated' || c.score == null) return 'neutral';
  if (c.score >= TAU_HI) return 'success';
  if (c.score >= TAU_LO) return 'warning';
  return 'neutral';
}
const isWeak = (b: Beat) => b.score == null || b.score < TAU_LO;

export function Storyboard({
  projectId,
  aspect,
  busy,
  onApprove,
}: {
  projectId: string;
  aspect: string;
  busy: boolean;
  onApprove: () => void;
}) {
  const [researchBeat, setResearchBeat] = useState<Beat | null>(null);
  const [swapBeat, setSwapBeat] = useState<Beat | null>(null);
  const [researching, setResearching] = useState<Record<string, number>>({}); // beatId → prior candidate count

  const { data, isLoading, isError, refetch } = useQuery<{ beats: Beat[] }>({
    queryKey: ['beats', projectId],
    queryFn: () => fetch(`/api/projects/${projectId}/beats`).then((r) => r.json()),
    refetchInterval: Object.keys(researching).length > 0 ? 1500 : false,
  });
  const beats = data?.beats ?? [];

  // Clear the researching shimmer once a beat's candidate set grows.
  useEffect(() => {
    if (Object.keys(researching).length === 0) return;
    let changed = false;
    const next = { ...researching };
    for (const b of beats) {
      if (b.id in researching && b.candidates.length > (researching[b.id] ?? 0)) {
        delete next[b.id];
        changed = true;
      }
    }
    if (changed) setResearching(next);
  }, [beats, researching]);

  const weakCount = beats.filter(isWeak).length;
  const total = beats.reduce((sum, b) => sum + (b.estSeconds ?? 0), 0);

  async function toggleTextcard(beat: Beat) {
    await fetch(`/api/beats/${beat.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ forcedTextcard: !beat.forcedTextcard }),
    }).catch(() => {});
    refetch();
  }

  function startResearch(beat: Beat) {
    setResearching((r) => ({ ...r, [beat.id]: beat.candidates.length }));
    setResearchBeat(null);
  }

  // A swap is the one place a human states a preference the ranker can be judged against:
  // "this one, not the one you picked". The PATCH re-keys fetch's inputsHash, so the montage
  // rebuilds from the new choice.
  async function swapCandidate(beat: Beat, candidateId: string): Promise<string | null> {
    const res = await fetch(`/api/beats/${beat.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chosenCandidateId: candidateId }),
    }).catch(() => null);
    if (!res?.ok) {
      const body = await res?.json().catch(() => ({}));
      return body?.error ?? 'Swap failed — the worker may be down.';
    }
    await refetch();
    return null;
  }

  if (isLoading) {
    return (
      <div className={`grid grid-cols-1 gap-4 ${ASPECT_COLS[aspect] ?? ''}`}>
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="h-64" />
        ))}
      </div>
    );
  }
  if (isError) {
    return (
      <Card className="border-danger/30">
        <p className="text-sm text-danger">Couldn’t load the storyboard.</p>
        <Button variant="outline" size="sm" className="mt-3" onClick={() => refetch()}>
          Retry
        </Button>
      </Card>
    );
  }

  return (
    <div className="space-y-5 pb-24">
      <div className="flex items-center gap-3">
        <span className="flex size-9 items-center justify-center rounded-xl bg-accent-quiet text-accent">
          <svg
            viewBox="0 0 24 24"
            className="size-5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            aria-hidden
          >
            <rect x="3" y="4" width="18" height="14" rx="2" strokeLinejoin="round" />
            <path d="M8 21h8M12 18v3" strokeLinecap="round" />
          </svg>
        </span>
        <div>
          <h2 className="text-base font-semibold">Storyboard</h2>
          <p className="text-sm text-fg-muted">
            Each beat is stitched into its real montage clip — press play to preview before
            rendering.
          </p>
        </div>
      </div>

      <div className={`grid grid-cols-1 gap-4 ${ASPECT_COLS[aspect] ?? ''}`}>
        {beats.map((beat) => (
          <BeatCard
            key={beat.id}
            beat={beat}
            aspect={aspect}
            researching={beat.id in researching}
            onResearch={() => setResearchBeat(beat)}
            onTextcard={() => toggleTextcard(beat)}
            onSwap={() => setSwapBeat(beat)}
          />
        ))}
      </div>

      {/* sticky footer — portaled so `fixed` pins to the viewport, not the animated page */}
      <Portal>
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-bg/85 backdrop-blur-xl lg:left-64">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-3 sm:px-8">
            <div className="flex items-center gap-3 text-sm">
              {weakCount > 0 ? (
                <span className="flex items-center gap-2 text-warning">
                  <Dot tone="warning" />
                  {weakCount} {weakCount === 1 ? 'beat is a weak match' : 'beats are weak matches'}{' '}
                  — re-search or continue
                </span>
              ) : (
                <span className="flex items-center gap-2 text-success">
                  <Dot tone="success" /> All {beats.length} beats matched well
                </span>
              )}
              <span className="hidden text-fg-subtle sm:inline">· {fmtDuration(total)} total</span>
            </div>
            <Button variant="primary" disabled={busy} onClick={onApprove}>
              {busy ? <Spinner /> : 'Approve & render'}
            </Button>
          </div>
        </div>
      </Portal>

      {researchBeat && (
        <ReSearchDialog
          beat={researchBeat}
          onSubmitted={() => startResearch(researchBeat)}
          onClose={() => setResearchBeat(null)}
        />
      )}

      {swapBeat && (
        <CandidateDrawer
          beat={beats.find((b) => b.id === swapBeat.id) ?? swapBeat}
          onSwap={(candidateId) => swapCandidate(swapBeat, candidateId)}
          onClose={() => setSwapBeat(null)}
        />
      )}
    </div>
  );
}

function BeatCard({
  beat,
  aspect,
  researching,
  onResearch,
  onTextcard,
  onSwap,
}: {
  beat: Beat;
  aspect: string;
  researching: boolean;
  onResearch: () => void;
  onTextcard: () => void;
  onSwap: () => void;
}) {
  const chosen = beat.candidates.find((c) => c.id === beat.chosenCandidateId) ?? beat.candidates[0];
  const kind = beat.forcedTextcard ? 'textcard' : (chosen?.kind ?? 'textcard');
  const tone = scoreTone({ score: beat.score, kind });
  const [playing, setPlaying] = useState(false);
  // Play the REAL stitched beat clip (fetch runs before the gate, doc 24 §8) — available
  // for every non-textcard beat, montage or single, video or Ken Burns still.
  const canPlay = !beat.forcedTextcard && !!beat.clipUrl;
  const poster = chosen?.thumbPath ?? beat.segments?.[0]?.thumbPath ?? null;
  const montage =
    !beat.forcedTextcard && beat.segments && beat.segments.length > 1 ? beat.segments : null;
  return (
    <Card bare className="flex flex-col">
      <div
        className={`relative overflow-hidden rounded-t-xl bg-bg ${ASPECT_THUMB[aspect] ?? 'aspect-video'}`}
      >
        {beat.forcedTextcard ? (
          <div className="flex size-full items-center justify-center bg-surface-2 text-xs text-fg-subtle">
            text card
          </div>
        ) : playing && beat.clipUrl ? (
          <video
            src={beat.clipUrl}
            controls
            autoPlay
            muted
            playsInline
            className="size-full bg-black object-contain"
            onClick={(e) => e.stopPropagation()}
          />
        ) : poster ? (
          <img src={fileUrl(poster)} alt="" className="size-full object-cover" />
        ) : (
          <div className="flex size-full items-center justify-center bg-surface-2 text-xs text-fg-subtle">
            {beat.clipUrl ? 'ready' : 'no match'}
          </div>
        )}
        {canPlay && !playing && (
          <PlayBadge
            onClick={(e) => {
              e.stopPropagation();
              setPlaying(true);
            }}
          />
        )}
        {researching && (
          <div className="absolute inset-0 flex items-center justify-center bg-bg/70 backdrop-blur-sm">
            <span className="flex items-center gap-2 text-xs text-fg-muted">
              <Spinner className="text-accent" /> re-searching…
            </span>
          </div>
        )}
        <span className="absolute left-2 top-2 rounded-md bg-black/55 px-1.5 py-0.5 text-[10px] font-medium text-white backdrop-blur">
          #{beat.idx + 1}
        </span>
        <span className="absolute right-2 top-2 flex items-center gap-1">
          {montage && <Badge tone="accent">montage · {montage.length}</Badge>}
          <Badge tone={tone}>
            {kind === 'textcard' ? 'text' : kind === 'image' ? 'photo' : kind}
          </Badge>
        </span>
        {/* Static filmstrip: the ordered shots that make up this beat's stitched clip. */}
        {montage && !playing && (
          <div className="absolute inset-x-0 bottom-0 flex items-end gap-0.5 bg-gradient-to-t from-black/70 to-transparent p-1.5">
            {montage.map((s, i) => (
              <div
                key={`${s.candidateId}-${i}`}
                title={`shot ${i + 1} · ${s.kind === 'video' ? 'video' : 'photo'}`}
                className="relative h-8 flex-1 overflow-hidden rounded-sm border border-white/40 bg-surface-2"
              >
                {s.thumbPath && (
                  <img src={fileUrl(s.thumbPath)} alt="" className="size-full object-cover" />
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-2.5 p-3">
        <p className="line-clamp-2 text-sm leading-snug" title={beat.text}>
          {beat.text}
        </p>
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-fg-subtle">
          {beat.emotion && <Badge tone="neutral">{beat.emotion}</Badge>}
          {beat.estSeconds != null && <span>{beat.estSeconds.toFixed(1)}s beat</span>}
          {montage && <span>· {montage.length} shots</span>}
          {chosen?.provider && !beat.forcedTextcard && (
            // Authoritative/archive sources get the accent tone so a glance down the storyboard
            // shows where the redesign is winning (NASA/LoC/Wellcome/… vs generic stock).
            <Badge tone={isArchiveProvider(chosen.provider) ? 'accent' : 'neutral'}>
              {providerLabel(chosen.provider)}
            </Badge>
          )}
        </div>
        <div className="mt-auto flex gap-1.5 pt-1">
          {/* Swap is the primary action: it picks from candidates already on disk, so unlike
              Re-search it costs no provider quota — and it is the only one that records a
              human preference (doc 26). Disabled when a text card is pinned (nothing to
              choose) or when the beat has no alternates. */}
          <ActionBtn
            onClick={onSwap}
            label="Swap"
            disabled={beat.forcedTextcard || beat.candidates.length < 2}
          />
          <ActionBtn onClick={onResearch} label="Re-search" />
          <ActionBtn
            onClick={onTextcard}
            label={beat.forcedTextcard ? 'Un-pin' : 'Text card'}
            active={beat.forcedTextcard}
          />
        </div>
      </div>
    </Card>
  );
}

function ActionBtn({
  onClick,
  label,
  active = false,
  disabled = false,
}: {
  onClick: () => void;
  label: string;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex-1 rounded-lg border px-2 py-1.5 text-xs font-medium transition-colors duration-[var(--dur-fast)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border disabled:hover:text-fg-muted ${
        active
          ? 'border-accent/40 bg-accent-quiet text-accent'
          : 'border-border bg-surface-2 text-fg-muted hover:border-border-strong hover:text-fg'
      }`}
    >
      {label}
    </button>
  );
}

function ReSearchDialog({
  beat,
  onSubmitted,
  onClose,
}: {
  beat: Beat;
  onSubmitted: () => void;
  onClose: () => void;
}) {
  const [desc, setDesc] = useState(beat.visualDescription ?? '');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const quota = useQuery<{ meters: { key: string; remaining: number }[] }>({
    queryKey: ['quota'],
    queryFn: () => fetch('/api/quota').then((r) => r.json()),
  });
  const pexels = quota.data?.meters.find((m) => m.key === 'pexels:hour')?.remaining ?? null;
  const low = pexels != null && pexels < 4;

  async function submit() {
    setBusy(true);
    setError(null);
    const body: Record<string, string> = {};
    if (desc.trim() && desc.trim() !== (beat.visualDescription ?? ''))
      body.visualDescription = desc.trim();
    if (query.trim()) body.customQuery = query.trim();
    const res = await fetch(`/api/beats/${beat.id}/research`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      onSubmitted();
    } else {
      const b = await res.json().catch(() => ({}));
      setError(b.error ?? 'Re-search failed');
      setBusy(false);
    }
  }

  return (
    <Portal>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm animate-[var(--animate-fade-in)]">
        <Card className="w-full max-w-md space-y-4 animate-[var(--animate-scale-in)]">
          <div>
            <h3 className="text-sm font-semibold">Re-search beat {beat.idx + 1}</h3>
            <p className="mt-1 line-clamp-2 text-xs text-fg-subtle">{beat.text}</p>
          </div>
          <label className="block space-y-1.5">
            <span className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
              Visual description{' '}
              <span className="font-normal normal-case text-fg-subtle">· English</span>
            </span>
            <textarea
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              rows={2}
              className="w-full resize-y rounded-lg border border-border bg-bg p-2.5 text-sm outline-none focus:border-accent/50 focus:ring-2 focus:ring-accent/25"
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
              Extra query <span className="font-normal normal-case text-fg-subtle">· optional</span>
            </span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="e.g. lunar module descent"
              className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent/50 focus:ring-2 focus:ring-accent/25"
            />
          </label>
          <div className="flex items-center justify-between text-xs">
            <span className={low ? 'text-warning' : 'text-fg-subtle'}>
              {pexels != null ? `${pexels} Pexels requests left this hour` : 'checking quota…'}
            </span>
            {low && <span className="text-warning">low — costs ≤ 4</span>}
          </div>
          {error && <p className="text-sm text-danger">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="subtle" size="sm" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" onClick={submit} disabled={busy}>
              {busy ? <Spinner /> : 'Re-search'}
            </Button>
          </div>
        </Card>
      </div>
    </Portal>
  );
}

// Pick a different asset for a beat from the candidates already scored and on disk.
//
// Specced as `CandidateDrawer` in doc 16 and never built, while the server half shipped complete and
// callerless (`PATCH /api/beats/[beatId]` has validated {chosenCandidateId} all along) — so the
// review gate could approve, but never disagree.
//
// It matters beyond convenience: a swap is the only human preference this system produces ("this
// one, not the one you ranked first"). Every calibration question currently open — τ, the penalty
// magnitudes, whether the four measured nulls are real — is starved of exactly that signal, because
// 192 of the eval fixture's 222 labels are a vision model judging a vision model (`pnpm eval:kappa`:
// κ vs human = 0.416 at reliability 1.000, i.e. biased, not noisy). Swapping costs no provider
// quota — these candidates were already fetched, scored, and embedded.
function CandidateDrawer({
  beat,
  onSwap,
  onClose,
}: {
  beat: Beat;
  onSwap: (candidateId: string) => Promise<string | null>;
  onClose: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  // Esc closes; focus moves into the panel on open so the drawer is keyboard-reachable and
  // does not strand focus behind the overlay (doc 16 §Accessibility).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    panelRef.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Rank by score, not by `rank`: the score stage drops gate-vetoed candidates before ranking, so
  // their `rank` still holds the search stage's unrelated 0-based value while `score` is NULL.
  // Sorting on `rank` would interleave never-ranked rows among the real ones.
  const ordered = [...beat.candidates].sort(
    (a, b) => (b.score ?? Number.NEGATIVE_INFINITY) - (a.score ?? Number.NEGATIVE_INFINITY),
  );
  const shown = showAll ? ordered : ordered.slice(0, STORYBOARD_CANDIDATES);
  const hiddenCount = ordered.length - shown.length;

  async function choose(candidateId: string) {
    if (candidateId === beat.chosenCandidateId) return onClose(); // already chosen — no-op
    setBusyId(candidateId);
    setError(null);
    const err = await onSwap(candidateId);
    if (err) {
      setError(err);
      setBusyId(null);
      return;
    }
    onClose();
  }

  return (
    <Portal>
      <div className="fixed inset-0 z-50 flex justify-end bg-black/60 backdrop-blur-sm animate-[var(--animate-fade-in)]">
        {/* Closes on Esc (bound above) and the Close button — matching ReSearchDialog. No
            click-outside-to-close: it needs a handler on a non-interactive overlay, and a
            mis-click would silently discard nothing here but is inconsistent with the rest. */}
        <div
          ref={panelRef}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-label={`Swap the asset for beat ${beat.idx + 1}`}
          className="flex h-full w-full max-w-lg flex-col gap-4 overflow-y-auto border-l border-border bg-surface p-5 outline-none"
        >
          <div>
            <div className="flex items-start justify-between gap-3">
              <h3 className="text-sm font-semibold">Swap beat {beat.idx + 1}</h3>
              <Button variant="subtle" size="sm" onClick={onClose}>
                Close
              </Button>
            </div>
            <p className="mt-1 line-clamp-2 text-xs text-fg-subtle">{beat.text}</p>
            {beat.visualDescription && (
              <p className="mt-2 text-xs text-fg-muted">
                <span className="font-semibold uppercase tracking-wide">Looking for</span>{' '}
                {beat.visualDescription}
              </p>
            )}
          </div>

          {error && (
            <p className="rounded-lg border border-danger/40 bg-danger/10 p-2.5 text-xs text-danger">
              {error}
            </p>
          )}

          {ordered.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
              <p className="text-sm text-fg-muted">No candidates for this beat.</p>
              <p className="max-w-xs text-xs text-fg-subtle">
                Re-search with a different description, or pin a text card.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {shown.map((c) => {
                const isChosen = c.id === beat.chosenCandidateId;
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => choose(c.id)}
                    disabled={busyId != null}
                    aria-current={isChosen}
                    className={`group relative overflow-hidden rounded-lg border text-left transition-colors duration-[var(--dur-fast)] disabled:opacity-60 ${
                      isChosen
                        ? 'border-accent ring-2 ring-accent/30'
                        : 'border-border hover:border-border-strong'
                    }`}
                  >
                    <div className="relative aspect-video bg-surface-2">
                      {c.thumbPath ? (
                        <img
                          src={fileUrl(c.thumbPath)}
                          alt=""
                          loading="lazy"
                          className="size-full object-cover"
                        />
                      ) : (
                        <div className="flex size-full items-center justify-center text-[10px] text-fg-subtle">
                          {c.kind}
                        </div>
                      )}
                      {busyId === c.id && (
                        <div className="absolute inset-0 flex items-center justify-center bg-bg/70">
                          <Spinner className="text-accent" />
                        </div>
                      )}
                      {isChosen && (
                        <span className="absolute left-1.5 top-1.5">
                          <Badge tone="accent">chosen</Badge>
                        </span>
                      )}
                    </div>
                    <div className="space-y-1 p-2">
                      <div className="flex items-center justify-between gap-1.5 text-[11px]">
                        <Badge tone={isArchiveProvider(c.provider) ? 'accent' : 'neutral'}>
                          {providerLabel(c.provider)}
                        </Badge>
                        {/* The model's own score, shown so a swap is a disagreement you can see. */}
                        <span className="tabular-nums text-fg-subtle">
                          {c.score != null ? c.score.toFixed(3) : '—'}
                        </span>
                      </div>
                      <p className="truncate text-[10px] text-fg-subtle">
                        {c.kind === 'video' && c.duration != null
                          ? `video · ${fmtDuration(c.duration)}`
                          : c.kind}
                        {c.author ? ` · ${c.author}` : ''}
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {hiddenCount > 0 && (
            <Button variant="subtle" size="sm" onClick={() => setShowAll(true)}>
              Show all {ordered.length} candidates
            </Button>
          )}
        </div>
      </div>
    </Portal>
  );
}
