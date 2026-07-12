'use client';

import { useRouter } from 'next/navigation';
import { use, useState } from 'react';
import { PipelineActivity } from '../../../components/PipelineActivity';
import { type Editable, RerenderPanel } from '../../../components/RerenderPanel';
import { StageStepper } from '../../../components/StageStepper';
import { Storyboard } from '../../../components/Storyboard';
import {
  Badge,
  Button,
  Card,
  Dot,
  ErrorPanel,
  ProgressBar,
  Skeleton,
  Spinner,
} from '../../../components/ui';
import { type Render, useProject } from '../../../hooks/useProject';
import { fileUrl, fmtBytes, fmtDuration } from '../../../lib/format';

// Pull the re-render panel's editable subset out of the stored settings blob.
function rerenderCurrent(settings: Record<string, unknown>): Editable {
  return {
    aspect: (settings.aspect as Editable['aspect']) ?? '16:9',
    quality: (settings.quality as Editable['quality']) ?? 'final',
    subtitlePreset: (settings.subtitlePreset as Editable['subtitlePreset']) ?? 'clean',
    subtitlePosition: (settings.subtitlePosition as Editable['subtitlePosition']) ?? 'bottom',
    musicMood: (settings.musicMood as Editable['musicMood']) ?? 'auto',
    musicLevelDb: (settings.musicLevelDb as number) ?? -16,
  };
}

export default function Workspace({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { data, isLoading, isError, refetch } = useProject(id);
  const [busy, setBusy] = useState(false);

  async function post(path: string) {
    setBusy(true);
    await fetch(`/api/projects/${id}/${path}`, { method: 'POST' }).catch(() => {});
    await refetch();
    setBusy(false);
  }

  async function del() {
    if (!window.confirm('Delete this project and its render? This cannot be undone.')) return;
    setBusy(true);
    const res = await fetch(`/api/projects/${id}`, { method: 'DELETE' }).catch(() => null);
    if (res?.ok) router.push('/');
    else setBusy(false);
  }

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-80" />
      </div>
    );
  }
  // Guard project too: a deleted/missing project returns a body without `project`, which
  // would otherwise crash on `project.status` below.
  if (isError || !data?.project)
    return <ErrorPanel title="Couldn’t load this project." onRetry={refetch} />;

  const { project, runs, overall, renders } = data;
  const status = project.status;

  return (
    <div className="space-y-6 animate-[var(--animate-fade-up)]">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold tracking-tight">{project.title}</h1>
          <p className="mt-0.5 font-mono text-xs text-fg-subtle">#{project.id.slice(0, 8)}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <StatusBadge status={status} />
          {status !== 'queued' && status !== 'running' && (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={del}
              aria-label="Delete project"
            >
              <svg
                viewBox="0 0 24 24"
                className="size-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                aria-hidden
              >
                <path
                  d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </Button>
          )}
        </div>
      </div>

      {status === 'draft' && (
        <Card className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
          <div>
            <p className="text-sm font-medium">Ready to generate</p>
            <p className="mt-0.5 text-sm text-fg-muted">
              Your settings are saved. Kick off the pipeline when you’re ready.
            </p>
          </div>
          <Button variant="primary" disabled={busy} onClick={() => post('generate')}>
            {busy ? <Spinner /> : 'Generate video'}
          </Button>
        </Card>
      )}

      {(status === 'queued' || status === 'running') && (
        <Card className="space-y-5">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <Dot tone="progress" pulse />
              <span className="text-sm font-medium">
                {status === 'queued' ? 'Queued' : 'Generating your video'}
              </span>
              <span aria-live="polite" className="font-mono text-sm text-progress">
                {overall}%
              </span>
            </div>
            <Button variant="danger" size="sm" disabled={busy} onClick={() => post('cancel')}>
              Cancel
            </Button>
          </div>
          <ProgressBar value={overall} tone="progress" />
          <PipelineActivity projectId={id} runs={runs} />
          <div className="border-t border-border pt-4">
            <StageStepper runs={runs} />
          </div>
        </Card>
      )}

      {status === 'awaiting_review' && (
        <Storyboard
          projectId={id}
          aspect={(project.settings.aspect as string) ?? '16:9'}
          busy={busy}
          onApprove={() => post('continue')}
        />
      )}

      {status === 'failed' && (
        <ErrorPanel
          title={`${project.error?.code ?? 'E_FAILED'} — ${project.error?.message ?? 'generation failed'}`}
          detail={JSON.stringify(project.error, null, 2)}
          onRetry={() => post('generate')}
        />
      )}

      {status === 'done' && renders[0] && (
        <>
          <Result render={renders[0]} history={renders} />
          <RerenderPanel
            projectId={id}
            current={rerenderCurrent(project.settings)}
            onQueued={() => void refetch()}
          />
        </>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<
    string,
    {
      label: string;
      tone: 'neutral' | 'accent' | 'success' | 'progress' | 'danger';
      pulse?: boolean;
    }
  > = {
    draft: { label: 'Draft', tone: 'neutral' },
    queued: { label: 'Queued', tone: 'progress', pulse: true },
    running: { label: 'Generating', tone: 'progress', pulse: true },
    awaiting_review: { label: 'Review', tone: 'accent' },
    done: { label: 'Done', tone: 'success' },
    failed: { label: 'Failed', tone: 'danger' },
  };
  const m = map[status] ?? map.draft;
  return (
    <Badge tone={m?.tone ?? 'neutral'}>
      {m?.pulse && <Dot tone="progress" pulse />}
      {m?.label ?? status}
    </Badge>
  );
}

function Result({ render, history }: { render: Render; history: Render[] }) {
  const [showCredits, setShowCredits] = useState(false);
  const [credits, setCredits] = useState('');
  const [copied, setCopied] = useState(false);
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

  function copyPath() {
    navigator.clipboard?.writeText(render.path);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="space-y-5">
      <Card bare className="overflow-hidden">
        {/* biome-ignore lint/a11y/useMediaCaption: a user-generated render has no captions track */}
        <video
          controls
          poster={render.thumbnail_path ? fileUrl(render.thumbnail_path) : undefined}
          src={videoUrl}
          className="aspect-video w-full bg-black"
        />
        <div className="flex flex-col gap-4 p-5">
          <div className="flex flex-wrap items-center gap-2 text-sm text-fg-muted">
            <Badge tone="success">
              <Dot tone="success" /> Rendered
            </Badge>
            <Badge tone="neutral">{render.aspect}</Badge>
            <Badge tone="neutral">{render.preset}</Badge>
            <span className="text-fg-subtle">·</span>
            <span>{fmtDuration(render.duration)}</span>
            <span className="text-fg-subtle">·</span>
            <span>{fmtBytes(render.bytes)}</span>
          </div>
          <div className="flex flex-wrap gap-2">
            <a href={videoUrl} download="final.mp4">
              <Button variant="primary">
                <svg
                  viewBox="0 0 24 24"
                  className="size-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  aria-hidden
                >
                  <path
                    d="M12 3v12m0 0 4-4m-4 4-4-4M4 21h16"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                Download MP4
              </Button>
            </a>
            <Button variant="subtle" onClick={copyPath}>
              {copied ? 'Copied ✓' : 'Copy path'}
            </Button>
            <Button variant="ghost" onClick={openCredits}>
              Credits
            </Button>
          </div>
        </div>
      </Card>

      {history.length > 1 && (
        <div>
          <h3 className="mb-2.5 text-sm font-semibold">Render history</h3>
          <div className="flex gap-3 overflow-x-auto pb-1">
            {history.map((r) => (
              <div key={r.id} className="w-44 shrink-0">
                {r.thumbnail_path && (
                  <img
                    src={fileUrl(r.thumbnail_path)}
                    alt=""
                    className="aspect-video w-full rounded-lg border border-border object-cover"
                  />
                )}
                <div className="mt-1.5 text-xs text-fg-subtle">
                  {r.aspect} · {r.preset}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {showCredits && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm animate-[var(--animate-fade-in)]">
          <Card className="max-h-[70vh] w-full max-w-lg overflow-auto animate-[var(--animate-scale-in)]">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold">Credits &amp; licenses</h3>
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => navigator.clipboard?.writeText(credits)}
                >
                  Copy
                </Button>
                <Button variant="subtle" size="sm" onClick={() => setShowCredits(false)}>
                  Close
                </Button>
              </div>
            </div>
            <pre className="whitespace-pre-wrap rounded-lg bg-bg p-4 font-mono text-xs leading-relaxed text-fg-muted">
              {credits}
            </pre>
          </Card>
        </div>
      )}
    </div>
  );
}
