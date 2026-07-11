'use client';

import { use, useState } from 'react';
import { StageStepper } from '../../../components/StageStepper';
import { Badge, Button, Card, ErrorPanel, Skeleton } from '../../../components/ui';
import { type Render, useProject } from '../../../hooks/useProject';
import { fileUrl, fmtBytes, fmtDuration } from '../../../lib/format';

export default function Workspace({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data, isLoading, isError, refetch } = useProject(id);
  const [busy, setBusy] = useState(false);

  async function post(path: string) {
    setBusy(true);
    await fetch(`/api/projects/${id}/${path}`, { method: 'POST' }).catch(() => {});
    await refetch();
    setBusy(false);
  }

  if (isLoading) return <Skeleton className="h-64" />;
  if (isError || !data) return <ErrorPanel title="Couldn’t load this project." onRetry={refetch} />;

  const { project, runs, overall, renders } = data;
  const status = project.status;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="truncate text-xl font-semibold">{project.title}</h1>
        <StatusBadge status={status} />
      </div>

      {status === 'draft' && (
        <Card className="flex items-center justify-between">
          <p className="text-sm text-fg-muted">Ready to generate.</p>
          <Button variant="primary" disabled={busy} onClick={() => post('generate')}>
            Generate
          </Button>
        </Card>
      )}

      {(status === 'queued' || status === 'running') && (
        <Card className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium">Generating</span>
              <span aria-live="polite" className="font-mono text-sm text-progress">
                {overall}%
              </span>
            </div>
            <Button variant="danger" disabled={busy} onClick={() => post('cancel')}>
              Cancel
            </Button>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-surface-2">
            <div
              className="h-full rounded-full bg-progress transition-[width] duration-500"
              style={{ width: `${overall}%` }}
            />
          </div>
          <StageStepper runs={runs} />
        </Card>
      )}

      {status === 'awaiting_review' && (
        <ReviewPane onApprove={() => post('continue')} busy={busy} runs={runs} />
      )}

      {status === 'failed' && (
        <ErrorPanel
          title={`${project.error?.code ?? 'E_FAILED'} — ${project.error?.message ?? 'generation failed'}`}
          detail={JSON.stringify(project.error, null, 2)}
          onRetry={() => post('generate')}
        />
      )}

      {status === 'done' && renders[0] && <Result render={renders[0]} history={renders} />}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<
    string,
    { label: string; tone: 'neutral' | 'accent' | 'success' | 'progress' | 'danger' }
  > = {
    draft: { label: 'Draft', tone: 'neutral' },
    queued: { label: 'Queued', tone: 'progress' },
    running: { label: 'Generating', tone: 'progress' },
    awaiting_review: { label: 'Review', tone: 'accent' },
    done: { label: 'Done', tone: 'success' },
    failed: { label: 'Failed', tone: 'danger' },
  };
  const m = map[status] ?? map.draft;
  return <Badge tone={m?.tone ?? 'neutral'}>{m?.label ?? status}</Badge>;
}

function ReviewPane({
  onApprove,
  busy,
  runs,
}: {
  onApprove: () => void;
  busy: boolean;
  runs: { stage: string; status: string }[];
}) {
  return (
    <Card className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-medium">Storyboard ready</h2>
          <p className="mt-1 text-sm text-fg-muted">
            Assets are selected. Full swap / re-search lands in the storyboard (Phase 12) — approve
            to render now.
          </p>
        </div>
        <Button variant="primary" disabled={busy} onClick={onApprove}>
          Approve &amp; render
        </Button>
      </div>
      <StageStepper runs={runs as never} />
    </Card>
  );
}

function Result({ render, history }: { render: Render; history: Render[] }) {
  const [showCredits, setShowCredits] = useState(false);
  const [credits, setCredits] = useState('');
  const videoUrl = fileUrl(render.path);

  async function openCredits() {
    const url = videoUrl.replace(/final\.mp4$/, 'credits.txt');
    setCredits(
      await fetch(url)
        .then((r) => r.text())
        .catch(() => 'credits unavailable'),
    );
    setShowCredits(true);
  }

  return (
    <div className="space-y-4">
      <Card className="space-y-4">
        {/* biome-ignore lint/a11y/useMediaCaption: a user-generated render has no captions track */}
        <video
          controls
          poster={render.thumbnail_path ? fileUrl(render.thumbnail_path) : undefined}
          src={videoUrl}
          className="w-full rounded-md bg-black"
        />
        <div className="flex flex-wrap items-center gap-3 text-sm text-fg-muted">
          <Badge tone="neutral">{render.aspect}</Badge>
          <Badge tone="neutral">{render.preset}</Badge>
          <span>{fmtDuration(render.duration)}</span>
          <span>{fmtBytes(render.bytes)}</span>
        </div>
        <div className="flex flex-wrap gap-2">
          <a href={videoUrl} download="final.mp4">
            <Button variant="primary">Download MP4</Button>
          </a>
          <Button variant="ghost" onClick={() => navigator.clipboard?.writeText(render.path)}>
            Copy path
          </Button>
          <Button variant="ghost" onClick={openCredits}>
            Credits
          </Button>
        </div>
      </Card>

      {history.length > 1 && (
        <div>
          <h3 className="mb-2 text-sm font-medium">Render history</h3>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {history.map((r) => (
              <div key={r.id} className="w-40 shrink-0">
                {r.thumbnail_path && (
                  // biome-ignore lint/performance/noImgElement: served from local /api/files, not a remote CDN
                  <img
                    src={fileUrl(r.thumbnail_path)}
                    alt=""
                    className="aspect-video w-full rounded-md object-cover"
                  />
                )}
                <div className="mt-1 text-xs text-fg-subtle">
                  {r.aspect} · {r.preset}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {showCredits && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <Card className="max-h-[70vh] w-full max-w-lg overflow-auto">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-medium">Credits</h3>
              <div className="flex gap-2">
                <Button variant="ghost" onClick={() => navigator.clipboard?.writeText(credits)}>
                  Copy
                </Button>
                <Button variant="ghost" onClick={() => setShowCredits(false)}>
                  Close
                </Button>
              </div>
            </div>
            <pre className="whitespace-pre-wrap font-mono text-xs text-fg-muted">{credits}</pre>
          </Card>
        </div>
      )}
    </div>
  );
}
