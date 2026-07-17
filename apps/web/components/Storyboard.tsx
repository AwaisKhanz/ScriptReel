'use client';

import { isArchiveProvider, providerLabel, TAU_HI, TAU_LO } from '@scriptreel/core';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
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
  // Read-only by design (2026-07-17): the selector picks, and the storyboard is where you SEE
  // what it picked before spending a render on it. Per-beat re-search and manual swap are gone —
  // no polling to do, so this query fetches once.
  const { data, isLoading, isError, refetch } = useQuery<{ beats: Beat[] }>({
    queryKey: ['beats', projectId],
    queryFn: () => fetch(`/api/projects/${projectId}/beats`).then((r) => r.json()),
  });
  const beats = data?.beats ?? [];

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
            Each beat is stitched into its real montage clip — press play to preview before
            rendering. Every shot was picked automatically.
          </p>
        </div>
      </div>

      <div className={`grid grid-cols-1 gap-4 ${ASPECT_COLS[aspect] ?? ''}`}>
        {beats.map((beat) => (
          <BeatCard key={beat.id} beat={beat} aspect={aspect} />
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
                  {weakCount} {weakCount === 1 ? 'beat is a weak match' : 'beats are weak matches'}
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
    </div>
  );
}

function BeatCard({ beat, aspect }: { beat: Beat; aspect: string }) {
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
      </div>
    </Card>
  );
}
