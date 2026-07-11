'use client';

import { useQuery } from '@tanstack/react-query';
import { Badge, Button, Card, Dot, ProgressBar, Skeleton } from '../../components/ui';

interface Health {
  ok: boolean;
  checks: {
    db: { ok: boolean };
    sidecar: { ok: boolean; device?: string; models?: Record<string, string> };
    ffmpeg: { ok: boolean; version?: number; libass?: boolean };
    keys: { ok: boolean; pexels: boolean; pixabay: boolean; openai: boolean };
  };
}
interface Quota {
  meters: { key: string; unit: string; used: number; budget: number; remaining: number }[];
}

export default function SettingsPage() {
  const health = useQuery<Health>({
    queryKey: ['health'],
    queryFn: () => fetch('/api/health').then((r) => r.json()),
    refetchInterval: 30_000,
  });
  const quota = useQuery<Quota>({
    queryKey: ['quota'],
    queryFn: () => fetch('/api/quota').then((r) => r.json()),
    refetchInterval: 5000,
  });

  return (
    <div className="space-y-8 animate-[var(--animate-fade-up)]">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-fg-muted">
          Local engine status, models, and provider budgets.
        </p>
      </div>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">System health</h2>
          <Button variant="ghost" size="sm" onClick={() => health.refetch()}>
            Re-check
          </Button>
        </div>
        {health.isLoading ? (
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-24" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <HealthCard title="Database" ok={health.data?.checks.db.ok} />
            <HealthCard
              title="Sidecar"
              ok={health.data?.checks.sidecar.ok}
              detail={health.data?.checks.sidecar.device}
            />
            <HealthCard
              title="FFmpeg"
              ok={health.data?.checks.ffmpeg.ok}
              detail={health.data?.checks.ffmpeg.libass ? 'libass ✓' : 'no libass'}
            />
            <HealthCard
              title="API keys"
              ok={health.data?.checks.keys.ok}
              detail={
                health.data
                  ? [
                      health.data.checks.keys.openai && 'OpenAI',
                      health.data.checks.keys.pexels && 'Pexels',
                      health.data.checks.keys.pixabay && 'Pixabay',
                    ]
                      .filter(Boolean)
                      .join(' · ')
                  : ''
              }
            />
          </div>
        )}
      </section>

      {health.data?.checks.sidecar.models && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold">Models</h2>
          <Card className="flex flex-wrap gap-2">
            {Object.entries(health.data.checks.sidecar.models).map(([name, state]) => (
              <Badge key={name} tone={state === 'loaded' ? 'success' : 'neutral'}>
                {state === 'loaded' && <Dot tone="success" />}
                {name}: {state}
              </Badge>
            ))}
          </Card>
        </section>
      )}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Provider quota</h2>
        {quota.isLoading ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-24" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {quota.data?.meters.map((m) => {
              const pct = m.budget > 0 ? Math.round((m.used / m.budget) * 100) : 0;
              const tone = pct > 85 ? 'danger' : pct > 60 ? 'progress' : 'accent';
              return (
                <Card key={m.key} className="space-y-2.5">
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-medium capitalize">{m.key.replace(':', ' · ')}</span>
                    <span className="font-mono text-xs text-fg-muted">
                      {m.used.toLocaleString()}/{m.budget.toLocaleString()}
                    </span>
                  </div>
                  <ProgressBar value={pct} tone={tone} className="h-1.5" />
                  <p className="text-xs text-fg-subtle">
                    {m.remaining.toLocaleString()} left this {m.unit}
                  </p>
                </Card>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

function HealthCard({
  title,
  ok,
  detail,
}: {
  title: string;
  ok?: boolean | undefined;
  detail?: string | undefined;
}) {
  return (
    <Card className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold">{title}</span>
        <Dot tone={ok ? 'success' : ok === false ? 'danger' : 'neutral'} pulse={ok === true} />
      </div>
      <div className="truncate text-xs text-fg-subtle">
        {detail ?? (ok ? 'healthy' : 'unavailable')}
      </div>
    </Card>
  );
}
