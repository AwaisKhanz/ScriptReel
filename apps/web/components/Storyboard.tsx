'use client';

import { isArchiveProvider, providerLabel, TAU_HI, TAU_LO } from '@scriptreel/core';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { getJson } from '../lib/api';
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
  mode,
  onRender,
  onRescore,
}: {
  projectId: string;
  aspect: string;
  busy: boolean;
  // 'review' = awaiting_review (approve & render); 'edit' = done (re-render after swaps).
  mode: 'review' | 'edit';
  onRender: () => void;
  onRescore: () => void;
}) {
  // The selector picks, and you SEE what it picked before (or after) spending a render — and can
  // swap any beat to one of its alternates if the pick is off (restored 2026-07-18).
  const { data, isLoading, isError, refetch } = useQuery<{ beats: Beat[]; vlmSkipped?: boolean }>({
    queryKey: ['beats', projectId],
    queryFn: () => getJson(`/api/projects/${projectId}/beats`),
  });
  const beats = data?.beats ?? [];
  const vlmSkipped = data?.vlmSkipped === true;

  // Beats whose clip the user changed this session — their stitched clipUrl is stale until the next
  // render, so we show the new poster + a "changed" badge and gate the render button on `dirty`.
  const [changed, setChanged] = useState<Set<string>>(new Set());
  const [swappingBeat, setSwappingBeat] = useState<string | null>(null);
  const dirty = changed.size > 0;

  async function swap(beatId: string, candidateId: string) {
    setSwappingBeat(beatId);
    const res = await fetch(`/api/projects/${projectId}/beats/choose`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ beatId, candidateId }),
    }).catch(() => null);
    if (res?.ok) {
      setChanged((prev) => new Set(prev).add(beatId));
      await refetch();
    }
    setSwappingBeat(null);
  }

  const weakCount = beats.filter(isWeak).length;
  const total = beats.reduce((sum, b) => sum + (b.estSeconds ?? 0), 0);

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
            Each beat is stitched into its real clip — press play to preview. If a pick is off, hit{' '}
            <span className="font-medium text-fg">Change clip</span> and choose an alternate.
          </p>
        </div>
      </div>

      {vlmSkipped && (
        <Card className="border-warning/40 bg-warning/5">
          <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
            <div className="flex flex-1 items-start gap-3">
              <Dot tone="warning" />
              <div>
                <p className="text-sm font-medium">Clips weren’t vision-verified</p>
                <p className="mt-0.5 text-sm text-fg-muted">
                  The AI vision model wasn’t available when these were scored, so they weren’t
                  double-checked for subject and era match. Make sure Ollama is serving the vision
                  model, then re-run scoring for verified clips.
                </p>
              </div>
            </div>
            <Button variant="outline" size="sm" disabled={busy} onClick={onRescore}>
              {busy ? <Spinner /> : 'Re-run scoring'}
            </Button>
          </div>
        </Card>
      )}

      <div className={`grid grid-cols-1 gap-4 ${ASPECT_COLS[aspect] ?? ''}`}>
        {beats.map((beat) => (
          <BeatCard
            key={beat.id}
            beat={beat}
            aspect={aspect}
            changed={changed.has(beat.id)}
            swapping={swappingBeat === beat.id}
            onSwap={(candidateId) => swap(beat.id, candidateId)}
          />
        ))}
      </div>

      {mode === 'review' ? (
        // At review the footer is the primary action — pin it to the viewport (portaled so `fixed`
        // resolves against the viewport, not the animated page).
        <Portal>
          <div className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-bg/85 backdrop-blur-xl lg:left-64">
            {footerBar()}
          </div>
        </Portal>
      ) : (
        // In the done view it sits inline below the grid, so it doesn't fight the result/re-render.
        <div className="overflow-hidden rounded-xl border border-border bg-surface/60">
          {footerBar()}
        </div>
      )}
    </div>
  );

  function footerBar() {
    return (
      <div className="flex items-center justify-between gap-4 px-5 py-3 sm:px-8">
        <div className="flex items-center gap-3 text-sm">
          {dirty ? (
            <span className="flex items-center gap-2 text-accent">
              <Dot tone="progress" />
              {changed.size} clip{changed.size === 1 ? '' : 's'} changed
            </span>
          ) : weakCount > 0 ? (
            <span className="flex items-center gap-2 text-warning">
              <Dot tone="warning" />
              {weakCount} {weakCount === 1 ? 'beat is a weak match' : 'beats are weak matches'}
            </span>
          ) : (
            <span className="flex items-center gap-2 text-success">
              <Dot tone="success" /> All {beats.length} beats matched well
            </span>
          )}
          <span className="hidden text-fg-subtle sm:inline">· {fmtDuration(total)} total</span>
        </div>
        <Button variant="primary" disabled={busy} onClick={onRender}>
          {busy ? (
            <Spinner />
          ) : mode === 'review' ? (
            'Approve & render'
          ) : dirty ? (
            'Re-render with changes'
          ) : (
            'Re-render'
          )}
        </Button>
      </div>
    );
  }
}

function BeatCard({
  beat,
  aspect,
  changed,
  swapping,
  onSwap,
}: {
  beat: Beat;
  aspect: string;
  changed: boolean;
  swapping: boolean;
  onSwap: (candidateId: string) => void;
}) {
  const chosen = beat.candidates.find((c) => c.id === beat.chosenCandidateId) ?? beat.candidates[0];
  const kind = beat.forcedTextcard ? 'textcard' : (chosen?.kind ?? 'textcard');
  const tone = scoreTone({ score: beat.score, kind });
  const [playing, setPlaying] = useState(false);
  const [swapOpen, setSwapOpen] = useState(false);
  // Alternates to swap to: the beat's other fetched candidates. A forced text card has none.
  const alternates = beat.candidates.filter((c) => c.id !== chosen?.id);
  const canSwap = !beat.forcedTextcard && alternates.length > 0;
  // What Play shows: normally the REAL stitched beat clip (fetch runs before the gate, doc 24 §8).
  // After a swap that stitched clip is stale, so preview the newly-chosen candidate's OWN video
  // (its direct remoteUrl) — enough to judge the swap before re-rendering. A chosen still/photo has
  // no video to play, so we just show its poster.
  const playSrc = changed
    ? chosen?.kind === 'video'
      ? (chosen.remoteUrl ?? null)
      : null
    : beat.clipUrl;
  const canPlay = !beat.forcedTextcard && !!playSrc;
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
        ) : playing && playSrc ? (
          <video
            src={playSrc}
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
        <span className="absolute left-2 top-2 rounded-md bg-black/55 px-1.5 py-0.5 text-[10px] font-medium text-white backdrop-blur">
          #{beat.idx + 1}
        </span>
        <span className="absolute right-2 top-2 flex items-center gap-1">
          {changed && <Badge tone="accent">changed</Badge>}
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

        {canSwap && (
          <div className="mt-auto pt-1">
            <button
              type="button"
              onClick={() => setSwapOpen((v) => !v)}
              className="flex items-center gap-1 text-xs font-medium text-accent transition-colors hover:text-accent/80"
            >
              {swapping ? <Spinner className="size-3" /> : null}
              {swapOpen ? 'Hide alternates' : 'Change clip'}
              <span className="text-fg-subtle">({alternates.length})</span>
            </button>
            {swapOpen && (
              <div className="mt-2 grid grid-cols-4 gap-1.5">
                {alternates.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    disabled={swapping}
                    onClick={() => onSwap(c.id)}
                    title={`${providerLabel(c.provider)}${c.score != null ? ` · ${c.score.toFixed(2)}` : ''}`}
                    className="relative aspect-video overflow-hidden rounded-md border border-border bg-surface-2 transition-colors hover:border-accent disabled:opacity-50"
                  >
                    {c.thumbPath ? (
                      <img src={fileUrl(c.thumbPath)} alt="" className="size-full object-cover" />
                    ) : (
                      <span className="flex size-full items-center justify-center text-[9px] text-fg-subtle">
                        {c.kind}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
