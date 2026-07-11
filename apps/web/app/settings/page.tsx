'use client';

import { useQuery } from '@tanstack/react-query';
import { Badge, Button, Card, Skeleton } from '../../components/ui';

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
  });
  const quota = useQuery<Quota>({
    queryKey: ['quota'],
    queryFn: () => fetch('/api/quota').then((r) => r.json()),
    refetchInterval: 5000,
  });

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-fg-muted">System health</h2>
          <Button variant="ghost" onClick={() => health.refetch()}>
            Re-check
          </Button>
        </div>
        {health.isLoading ? (
          <Skeleton className="h-28" />
        ) : (
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
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
        <section className="space-y-2">
          <h2 className="text-sm font-medium text-fg-muted">Models</h2>
          <Card className="flex flex-wrap gap-2">
            {Object.entries(health.data.checks.sidecar.models).map(([name, state]) => (
              <Badge key={name} tone={state === 'loaded' ? 'success' : 'neutral'}>
                {name}: {state}
              </Badge>
            ))}
          </Card>
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-fg-muted">Provider quota</h2>
        {quota.isLoading ? (
          <Skeleton className="h-24" />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {quota.data?.meters.map((m) => {
              const pct = Math.round((m.used / m.budget) * 100);
              return (
                <Card key={m.key} className="space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <span className="capitalize">{m.key.replace(':', ' / ')}</span>
                    <span className="font-mono text-xs text-fg-muted">
                      {m.used}/{m.budget}
                    </span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
                    <div
                      className={`h-full rounded-full ${pct > 85 ? 'bg-danger' : 'bg-accent'}`}
                      style={{ width: `${Math.min(100, pct)}%` }}
                    />
                  </div>
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
    <Card className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{title}</span>
        <span
          className={`size-2.5 rounded-full ${ok ? 'bg-success' : ok === false ? 'bg-danger' : 'bg-surface-2'}`}
        />
      </div>
      <div className="truncate text-xs text-fg-subtle">
        {detail ?? (ok ? 'healthy' : 'unavailable')}
      </div>
    </Card>
  );
}
