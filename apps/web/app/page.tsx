'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import type { CSSProperties } from 'react';
import { Badge, Card, Dot, ProgressBar, Skeleton } from '../components/ui';
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

interface QuotaMeter {
  key: string;
  unit: string;
  used: number;
  budget: number;
  remaining: number;
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
  const projects = useQuery<{ projects: ProjectCard[] }>({
    queryKey: ['projects'],
    queryFn: () => fetch('/api/projects').then((r) => r.json()),
    refetchInterval: 4000,
  });
  const quota = useQuery<{ meters: QuotaMeter[] }>({
    queryKey: ['quota'],
    queryFn: () => fetch('/api/quota').then((r) => r.json()),
    refetchInterval: 15_000,
  });

  const list = projects.data?.projects ?? [];

  return (
    <div className="space-y-7">
      {/* Hero */}
      <section className="hero-surface relative overflow-hidden rounded-2xl p-8 text-white shadow-[var(--shadow-lg)] animate-[var(--animate-fade-up)] sm:p-10">
        <div className="brand-gradient-animated pointer-events-none absolute inset-0 opacity-40 mix-blend-soft-light" />
        <div className="relative max-w-2xl">
          <span className="inline-flex items-center gap-2 rounded-full bg-white/15 px-3 py-1 text-xs font-medium backdrop-blur">
            <span className="size-1.5 rounded-full bg-white" />
            AI script-to-video · local &amp; free
          </span>
          <h1 className="mt-4 text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">
            Turn any script into a finished video.
          </h1>
          <p className="mt-3 max-w-xl text-sm leading-relaxed text-white/85 sm:text-base">
            Relevant B-roll, a natural voiceover, word-synced subtitles and music — cut to your
            narration in minutes.
          </p>
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <Link
              href="/projects/new"
              className="inline-flex h-11 items-center gap-2 rounded-xl bg-white px-5 text-sm font-semibold text-[color:var(--brand-2)] shadow-[var(--shadow-md)] transition-transform duration-[var(--dur-fast)] hover:scale-[1.02] active:scale-[0.98]"
            >
              <svg viewBox="0 0 24 24" className="size-4" fill="currentColor" aria-hidden>
                <path d="M13 2 4.5 13H11l-1 9 8.5-11H12z" />
              </svg>
              Create a video
            </Link>
          </div>
          <dl className="mt-8 flex flex-wrap gap-x-10 gap-y-4">
            <HeroStat value="54" label="voices · 9 languages" />
            <HeroStat value="3" label="aspect ratios" />
            <HeroStat value="$0" label="per render" />
          </dl>
        </div>
      </section>

      {/* Quota strip */}
      <section className="animate-[var(--animate-fade-up)] [animation-delay:80ms]">
        <Card className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="grid flex-1 grid-cols-1 gap-5 sm:grid-cols-3">
            {quota.isLoading
              ? [0, 1, 2].map((i) => <Skeleton key={i} className="h-9" />)
              : (quota.data?.meters ?? [])
                  .slice(0, 3)
                  .map((m) => <QuotaMeterBar key={m.key} m={m} />)}
          </div>
          <div className="flex items-center gap-4 border-t border-border pt-3 lg:border-l lg:border-t-0 lg:pl-6 lg:pt-0">
            {['db', 'sidecar', 'ffmpeg', 'keys'].map((s) => (
              <span key={s} className="flex items-center gap-1.5 text-xs text-fg-muted">
                <Dot tone="success" />
                {s}
              </span>
            ))}
          </div>
        </Card>
      </section>

      {/* Projects */}
      <section className="space-y-4">
        <div className="flex items-end justify-between">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Recent projects</h2>
            <p className="text-sm text-fg-muted">Paste a script. Get a video.</p>
          </div>
          {list.length > 0 && (
            <span className="text-sm text-fg-subtle">{list.length} projects</span>
          )}
        </div>

        {projects.isLoading && (
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-64" />
            ))}
          </div>
        )}

        {projects.isError && <ErrorCard onRetry={() => projects.refetch()} />}

        {projects.data && list.length === 0 && (
          <Card className="flex flex-col items-center gap-4 py-16 text-center">
            <span className="brand-gradient flex size-12 items-center justify-center rounded-2xl text-white shadow-[var(--shadow-glow)]">
              <svg
                viewBox="0 0 24 24"
                className="size-6"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                aria-hidden
              >
                <rect x="3" y="4" width="18" height="16" rx="2" strokeLinejoin="round" />
                <path d="M7 4v16M17 4v16" strokeLinecap="round" />
              </svg>
            </span>
            <div>
              <p className="font-medium">No projects yet</p>
              <p className="mt-1 text-sm text-fg-muted">Your first video is a paste away.</p>
            </div>
            <Link
              href="/projects/new"
              className="brand-gradient inline-flex h-10 items-center gap-2 rounded-xl px-5 text-sm font-semibold text-white shadow-[var(--shadow-glow)]"
            >
              Create your first video
            </Link>
          </Card>
        )}

        {projects.data && list.length > 0 && (
          <div className="stagger grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {list.map((p, i) => (
              <div key={p.id} style={{ '--i': i } as CSSProperties}>
                <ProjectTile p={p} />
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function HeroStat({ value, label }: { value: string; label: string }) {
  return (
    <div>
      <dt className="text-2xl font-semibold">{value}</dt>
      <dd className="text-xs text-white/75">{label}</dd>
    </div>
  );
}

function QuotaMeterBar({ m }: { m: QuotaMeter }) {
  const pct = m.budget > 0 ? Math.round((m.used / m.budget) * 100) : 0;
  const tone = pct > 85 ? 'danger' : pct > 60 ? 'progress' : 'accent';
  const [provider, window] = m.key.split(':');
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
          {provider}
          {window && <span className="text-fg-subtle"> · {window}</span>}
        </span>
        <span className="font-mono text-xs text-fg-subtle">
          {m.used.toLocaleString()} / {m.budget.toLocaleString()}
        </span>
      </div>
      <ProgressBar value={pct} tone={tone} className="mt-1.5 h-1.5" />
    </div>
  );
}

function ProjectTile({ p }: { p: ProjectCard }) {
  const s = STATUS[p.status] ?? STATUS.draft;
  const active = p.status === 'running' || p.status === 'queued';
  return (
    <Link href={`/projects/${p.id}`}>
      <Card interactive className="h-full">
        <div className="relative mb-3 flex aspect-video items-center justify-center overflow-hidden rounded-lg bg-bg">
          {p.thumbnail_path ? (
            <img
              src={fileUrl(p.thumbnail_path)}
              alt=""
              className="size-full object-cover transition-transform duration-[var(--dur-slow)] hover:scale-[1.03]"
            />
          ) : (
            <span className="text-xs text-fg-subtle">no render yet</span>
          )}
          <span className="absolute right-2 top-2 rounded-md bg-black/55 px-1.5 py-0.5 font-mono text-[10px] font-medium text-white backdrop-blur">
            {p.aspect ?? '—'}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <h3 className="truncate text-sm font-semibold">{p.title}</h3>
          {s && (
            <Badge tone={s.tone}>
              {active && <Dot tone="progress" pulse />}
              {s.label}
            </Badge>
          )}
        </div>
        {active ? (
          <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-surface-2">
            <div className="brand-gradient h-full w-1/3 animate-[var(--animate-shimmer)] rounded-full" />
          </div>
        ) : (
          <div className="mt-1.5 text-xs text-fg-subtle">{fmtDuration(p.duration)}</div>
        )}
      </Card>
    </Link>
  );
}

function ErrorCard({ onRetry }: { onRetry: () => void }) {
  return (
    <Card className="border-danger/30">
      <p className="text-sm text-danger">Couldn’t load projects.</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-3 text-sm font-medium text-accent hover:underline"
      >
        Retry
      </button>
    </Card>
  );
}
