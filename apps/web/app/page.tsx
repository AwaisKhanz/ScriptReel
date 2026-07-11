'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Badge, Button, Card, Skeleton } from '../components/ui';
import { fileUrl, fmtDuration } from '../lib/format';

interface ProjectCard {
  id: string;
  title: string;
  status: string;
  updated_at: string;
  duration: number | null;
  thumbnail_path: string | null;
  aspect: string | null;
}

const STATUS: Record<
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

export default function Dashboard() {
  const { data, isLoading, isError, refetch } = useQuery<{ projects: ProjectCard[] }>({
    queryKey: ['projects'],
    queryFn: () => fetch('/api/projects').then((r) => r.json()),
    refetchInterval: 4000,
  });

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
          <p className="mt-1 text-sm text-fg-muted">Paste a script. Get a video.</p>
        </div>
        <Link href="/projects/new">
          <Button variant="primary">New project</Button>
        </Link>
      </div>

      {isLoading && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-44" />
          ))}
        </div>
      )}

      {isError && (
        <Card className="border-danger/30">
          <p className="text-sm text-danger">Couldn’t load projects.</p>
          <Button variant="ghost" className="mt-3" onClick={() => refetch()}>
            Retry
          </Button>
        </Card>
      )}

      {data && data.projects.length === 0 && (
        <Card className="flex flex-col items-center gap-3 py-16 text-center">
          <p className="text-fg-muted">No projects yet.</p>
          <Link href="/projects/new">
            <Button variant="primary">Create your first video</Button>
          </Link>
        </Card>
      )}

      {data && data.projects.length > 0 && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {data.projects.map((p) => {
            const s = STATUS[p.status] ?? STATUS.draft;
            return (
              <Link key={p.id} href={`/projects/${p.id}`}>
                <Card className="group h-full cursor-pointer transition-colors hover:border-border-strong">
                  <div className="mb-3 flex aspect-video items-center justify-center overflow-hidden rounded-md bg-bg">
                    {p.thumbnail_path ? (
                      // biome-ignore lint/performance/noImgElement: served from local /api/files, not a remote CDN
                      <img
                        src={fileUrl(p.thumbnail_path)}
                        alt=""
                        className="size-full object-cover"
                      />
                    ) : (
                      <span className="text-xs text-fg-subtle">no render yet</span>
                    )}
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="truncate text-sm font-medium">{p.title}</h3>
                    {s && <Badge tone={s.tone}>{s.label}</Badge>}
                  </div>
                  <div className="mt-1 text-xs text-fg-subtle">
                    {p.aspect ?? '—'} · {fmtDuration(p.duration)}
                  </div>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
