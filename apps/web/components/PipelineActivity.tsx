'use client';

import { useQuery } from '@tanstack/react-query';
import type { StageRun } from '../hooks/useProject';
import { detailText, parseDetail } from '../lib/activity';
import { fileUrl } from '../lib/format';
import { Badge } from './ui';

interface Thumb {
  id: string;
  beatIdx: number;
  provider: string;
  kind: string;
  thumbPath: string | null;
}

// What the pipeline is doing RIGHT NOW (doc 16 realtime-via-poll): a live activity
// line ("Searching pexels videos · “crowded subway” — 18 found") plus the media found
// so far streaming in as thumbnails. Poll only while a visual stage is running; new
// thumbs scale in (keyed by id, so existing ones don't re-animate); DOM capped at 24.
const VISUAL_STAGES = new Set(['search', 'score', 'fetch']);

export function PipelineActivity({ projectId, runs }: { projectId: string; runs: StageRun[] }) {
  const active = runs.find((r) => r.status === 'running');
  const visual = active !== undefined && VISUAL_STAGES.has(active.stage);
  const { data } = useQuery<{ thumbs: Thumb[] }>({
    queryKey: ['activity', projectId],
    queryFn: () => fetch(`/api/projects/${projectId}/activity`).then((r) => r.json()),
    refetchInterval: 1200,
    enabled: visual,
  });

  if (!active) return null;
  const event = parseDetail(active.detail);
  const line = detailText(active.detail);
  const thumbs = visual ? (data?.thumbs ?? []) : [];

  return (
    <div className="space-y-3">
      {line && (
        <div className="flex min-w-0 items-center gap-2 text-sm text-fg-muted">
          <span className="relative flex size-2 shrink-0">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-progress opacity-60" />
            <span className="relative inline-flex size-2 rounded-full bg-progress" />
          </span>
          {event?.provider && <Badge tone="accent">{event.provider}</Badge>}
          <span aria-live="polite" className="truncate">
            {line}
          </span>
        </div>
      )}
      {thumbs.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {thumbs.map((t) => (
            <div
              key={t.id}
              title={`beat ${t.beatIdx + 1} · ${t.provider} ${t.kind}`}
              className="relative h-12 w-20 overflow-hidden rounded-md border border-border bg-surface-2 animate-[var(--animate-scale-in)]"
            >
              {t.thumbPath && (
                <img
                  src={fileUrl(t.thumbPath)}
                  alt=""
                  loading="lazy"
                  className="size-full object-cover"
                />
              )}
              <span className="absolute bottom-0.5 right-0.5 rounded bg-black/60 px-1 text-[9px] font-medium text-white">
                {t.kind === 'video' ? '▶' : '◻'}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
