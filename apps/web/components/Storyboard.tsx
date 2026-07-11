'use client';

import { TAU_HI, TAU_LO } from '@scriptreel/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { fileUrl, fmtDuration } from '../lib/format';
import { Badge, Button, Card, Dot, Skeleton, Spinner } from './ui';

export interface Candidate {
  id: string;
  kind: 'video' | 'image' | 'generated' | 'textcard';
  provider: string;
  thumbPath: string | null;
  remoteUrl: string | null; // direct media file — used to preview video in the browser
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

// Thumbnail that plays the real clip on demand. Video candidates get a play button;
// the source is the provider's file URL (nothing is downloaded until render).
function ThumbMedia({
  thumbPath,
  remoteUrl,
  playing,
}: {
  thumbPath: string | null;
  remoteUrl: string | null;
  playing: boolean;
}) {
  if (playing && remoteUrl) {
    return (
      <video
        src={remoteUrl}
        controls
        autoPlay
        muted
        playsInline
        className="size-full bg-black object-contain"
        onClick={(e) => e.stopPropagation()}
      />
    );
  }
  return thumbPath ? (
    <img src={fileUrl(thumbPath)} alt="" className="size-full object-cover" />
  ) : (
    <div className="flex size-full items-center justify-center bg-surface-2 text-xs text-fg-subtle">
      no preview
    </div>
  );
}

function PlayBadge({ onClick }: { onClick: (e: React.MouseEvent) => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Play preview"
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
  segments: { thumbPath: string | null; kind: string }[] | null; // montage sequence (doc 23 §7)
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
  const qc = useQueryClient();
  const [swapBeat, setSwapBeat] = useState<Beat | null>(null);
  const [researchBeat, setResearchBeat] = useState<Beat | null>(null);
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

  // Optimistic swap: update the cache immediately, then PATCH.
  async function choose(beatId: string, candidateId: string) {
    qc.setQueryData<{ beats: Beat[] }>(['beats', projectId], (prev) =>
      prev
        ? {
            beats: prev.beats.map((b) =>
              b.id === beatId ? { ...b, chosenCandidateId: candidateId } : b,
            ),
          }
        : prev,
    );
    setSwapBeat((s) => (s && s.id === beatId ? { ...s, chosenCandidateId: candidateId } : s));
    const res = await fetch(`/api/beats/${beatId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chosenCandidateId: candidateId }),
    }).catch(() => null);
    if (!res?.ok) refetch();
  }

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
            Review each beat — swap a clip, re-search, or pin a text card before rendering.
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
            onSwap={() => setSwapBeat(beat)}
            onResearch={() => setResearchBeat(beat)}
            onTextcard={() => toggleTextcard(beat)}
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
                  — swap or continue
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

      {swapBeat && (
        <SwapDrawer
          beat={beats.find((b) => b.id === swapBeat.id) ?? swapBeat}
          onChoose={(cid) => choose(swapBeat.id, cid)}
          onClose={() => setSwapBeat(null)}
        />
      )}
      {researchBeat && (
        <ReSearchDialog
          beat={researchBeat}
          onSubmitted={() => startResearch(researchBeat)}
          onClose={() => setResearchBeat(null)}
        />
      )}
    </div>
  );
}

function BeatCard({
  beat,
  aspect,
  researching,
  onSwap,
  onResearch,
  onTextcard,
}: {
  beat: Beat;
  aspect: string;
  researching: boolean;
  onSwap: () => void;
  onResearch: () => void;
  onTextcard: () => void;
}) {
  const chosen = beat.candidates.find((c) => c.id === beat.chosenCandidateId) ?? beat.candidates[0];
  const kind = beat.forcedTextcard ? 'textcard' : (chosen?.kind ?? 'textcard');
  const tone = scoreTone({ score: beat.score, kind });
  const [playing, setPlaying] = useState(false);
  const canPlay = !beat.forcedTextcard && chosen?.kind === 'video' && !!chosen.remoteUrl;
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
        ) : chosen ? (
          <ThumbMedia thumbPath={chosen.thumbPath} remoteUrl={chosen.remoteUrl} playing={playing} />
        ) : (
          <div className="flex size-full items-center justify-center bg-surface-2 text-xs text-fg-subtle">
            no match
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
        {montage && !playing && (
          <div className="absolute inset-x-0 bottom-0 flex items-end gap-0.5 bg-gradient-to-t from-black/70 to-transparent p-1.5">
            {montage.map((s, i) => (
              <div
                key={`${s.thumbPath ?? 'seg'}-${i}`}
                className="relative h-8 flex-1 overflow-hidden rounded-sm border border-white/40 bg-surface-2"
                title={`shot ${i + 1} · ${s.kind === 'video' ? 'video' : 'photo'}`}
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
          {chosen?.duration != null && <span>{chosen.duration.toFixed(1)}s clip</span>}
          {chosen?.provider && !beat.forcedTextcard && <span>· {chosen.provider}</span>}
        </div>
        <div className="mt-auto flex gap-1.5 pt-1">
          <ActionBtn onClick={onSwap} label="Swap" />
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
}: {
  onClick: () => void;
  label: string;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 rounded-lg border px-2 py-1.5 text-xs font-medium transition-colors duration-[var(--dur-fast)] ${
        active
          ? 'border-accent/40 bg-accent-quiet text-accent'
          : 'border-border bg-surface-2 text-fg-muted hover:border-border-strong hover:text-fg'
      }`}
    >
      {label}
    </button>
  );
}

function SwapDrawer({
  beat,
  onChoose,
  onClose,
}: {
  beat: Beat;
  onChoose: (candidateId: string) => void;
  onClose: () => void;
}) {
  const cands = beat.candidates;
  const chosenIdx = Math.max(
    0,
    cands.findIndex((c) => c.id === beat.chosenCandidateId),
  );
  const [cursor, setCursor] = useState(chosenIdx);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') onClose();
    else if (e.key === 'ArrowRight' || e.key === 'ArrowDown')
      setCursor((c) => Math.min(cands.length - 1, c + 1));
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') setCursor((c) => Math.max(0, c - 1));
    else if (e.key === 'Enter') {
      const c = cands[cursor];
      if (c) onChoose(c.id);
    }
  }

  return (
    <Portal>
      <div className="fixed inset-0 z-50 flex justify-end animate-[var(--animate-fade-in)]">
        <button type="button" aria-label="Close" className="flex-1 bg-black/50" onClick={onClose} />
        <div
          ref={ref}
          role="dialog"
          aria-label={`Swap clip for beat ${beat.idx + 1}`}
          tabIndex={-1}
          onKeyDown={onKeyDown}
          className="flex h-full w-full max-w-md flex-col border-l border-border bg-surface shadow-[var(--shadow-lg)] outline-none animate-[var(--animate-fade-up)]"
        >
          <div className="flex shrink-0 items-center justify-between border-b border-border p-4">
            <div>
              <h3 className="text-sm font-semibold">Swap clip · beat {beat.idx + 1}</h3>
              <p className="mt-0.5 text-xs text-fg-subtle">
                {cands.length} alternates · ▶ preview · ←/→ move · Enter choose · Esc close
              </p>
            </div>
            <Button variant="subtle" size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <div className="grid grid-cols-2 gap-3">
              {cands.map((c, i) => {
                const active = c.id === beat.chosenCandidateId;
                const isPlaying = playingId === c.id;
                const canPlay = c.kind === 'video' && !!c.remoteUrl;
                return (
                  // biome-ignore lint/a11y/useSemanticElements: nests a play button, so not a <button>
                  <div
                    key={c.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => onChoose(c.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onChoose(c.id);
                      }
                    }}
                    onMouseEnter={() => setCursor(i)}
                    className={`cursor-pointer overflow-hidden rounded-xl border text-left transition-all duration-[var(--dur-fast)] ${
                      active
                        ? 'border-accent ring-2 ring-accent/40'
                        : cursor === i
                          ? 'border-border-strong'
                          : 'border-border hover:border-border-strong'
                    }`}
                  >
                    <div className="relative aspect-video bg-bg">
                      <ThumbMedia
                        thumbPath={c.thumbPath}
                        remoteUrl={c.remoteUrl}
                        playing={isPlaying}
                      />
                      {active && !isPlaying && (
                        <span className="absolute right-1.5 top-1.5 flex size-5 items-center justify-center rounded-full bg-accent text-white">
                          <svg
                            viewBox="0 0 24 24"
                            className="size-3"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="3"
                            aria-hidden
                          >
                            <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </span>
                      )}
                      {canPlay && !isPlaying && (
                        <PlayBadge
                          onClick={(e) => {
                            e.stopPropagation();
                            setPlayingId(c.id);
                          }}
                        />
                      )}
                    </div>
                    <div className="space-y-1 p-2">
                      <div className="flex items-center justify-between">
                        <Badge tone={scoreTone(c)}>
                          {c.score != null ? c.score.toFixed(2) : c.kind}
                        </Badge>
                        <span className="text-[10px] uppercase tracking-wide text-fg-subtle">
                          {c.provider}
                        </span>
                      </div>
                      <div className="truncate text-xs text-fg-subtle">
                        {c.duration != null ? `${c.duration.toFixed(1)}s · ` : ''}
                        {c.author ?? '—'}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </Portal>
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
