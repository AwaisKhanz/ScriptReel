'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Pills } from '../../components/controls';
import { Badge, Button, Card, Dot, ProgressBar, Skeleton, Spinner } from '../../components/ui';
import { fmtBytes } from '../../lib/format';

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
  meters: {
    key: string;
    unit: string;
    used: number;
    budget: number;
    remaining: number;
    keys?: number;
  }[];
}
interface KeyRow {
  id: string;
  provider: string;
  label: string | null;
  active: boolean;
  masked: string;
}
const KEY_PROVIDERS = ['pexels', 'pixabay', 'openverse'] as const;
const PROVIDER_OPTIONS = [
  { value: 'pexels', label: 'Pexels' },
  { value: 'pixabay', label: 'Pixabay' },
  { value: 'openverse', label: 'Openverse' },
];
const PROVIDER_HELP: Record<string, string> = {
  pexels: 'https://www.pexels.com/api/',
  pixabay: 'https://pixabay.com/api/docs/',
  openverse: 'https://api.openverse.org/',
};

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
                  <p className="flex items-center justify-between text-xs text-fg-subtle">
                    <span>
                      {m.remaining.toLocaleString()} left this {m.unit}
                    </span>
                    {m.keys && m.keys > 1 && <span className="text-accent">× {m.keys} keys</span>}
                  </p>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      <KeysSection />
      <StorageSection />
    </div>
  );
}

function KeysSection() {
  const qc = useQueryClient();
  const [provider, setProvider] = useState<string>('pexels');
  const [secret, setSecret] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keys = useQuery<{ keys: KeyRow[] }>({
    queryKey: ['keys'],
    queryFn: () => fetch('/api/keys').then((r) => r.json()),
  });

  async function add() {
    if (secret.trim().length < 6) {
      setError('Enter a valid key');
      return;
    }
    setBusy(true);
    setError(null);
    const res = await fetch('/api/keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider, secret: secret.trim(), label: label.trim() || undefined }),
    });
    if (res.ok) {
      setSecret('');
      setLabel('');
      await qc.invalidateQueries({ queryKey: ['keys'] });
      await qc.invalidateQueries({ queryKey: ['quota'] });
    } else {
      setError((await res.json().catch(() => ({}))).error ?? 'Failed to add key');
    }
    setBusy(false);
  }

  async function remove(id: string) {
    await fetch(`/api/keys/${id}`, { method: 'DELETE' }).catch(() => {});
    await qc.invalidateQueries({ queryKey: ['keys'] });
    await qc.invalidateQueries({ queryKey: ['quota'] });
  }

  async function toggle(k: KeyRow) {
    await fetch(`/api/keys/${k.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ active: !k.active }),
    }).catch(() => {});
    await qc.invalidateQueries({ queryKey: ['keys'] });
    await qc.invalidateQueries({ queryKey: ['quota'] });
  }

  const rows = keys.data?.keys ?? [];

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold">API keys &amp; accounts</h2>
        <p className="mt-0.5 text-sm text-fg-muted">
          Add multiple keys per provider — the pipeline rotates across them, so combined free-tier
          quota scales and it keeps running past a single account&apos;s limit.
        </p>
      </div>

      <Card className="space-y-5">
        {/* Add-key form (inset) */}
        <div className="rounded-xl border border-border bg-surface-2 p-4">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
              Add a key
            </span>
            <a
              href={PROVIDER_HELP[provider]}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
            >
              get a {provider} key
              <svg
                viewBox="0 0 24 24"
                className="size-3"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden
              >
                <path d="M7 17 17 7M9 7h8v8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </a>
          </div>
          <div className="mt-3">
            <Pills value={provider} options={PROVIDER_OPTIONS} onChange={setProvider} />
          </div>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <input
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && add()}
              placeholder={
                provider === 'openverse' ? 'token (optional — anonymous works)' : 'paste API key…'
              }
              className="h-10 flex-1 rounded-lg border border-border bg-bg px-3 font-mono text-sm outline-none transition-colors focus:border-accent/50 focus:ring-2 focus:ring-accent/25"
            />
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && add()}
              placeholder="label (optional)"
              className="h-10 rounded-lg border border-border bg-bg px-3 text-sm outline-none transition-colors focus:border-accent/50 sm:w-44"
            />
            <Button variant="primary" disabled={busy} onClick={add}>
              {busy ? <Spinner /> : 'Add key'}
            </Button>
          </div>
          {error && <p className="mt-2 text-sm text-danger">{error}</p>}
        </div>

        {/* Pool, grouped by provider */}
        {keys.isLoading ? (
          <Skeleton className="h-16" />
        ) : rows.length === 0 ? (
          <p className="text-sm text-fg-subtle">
            No pooled keys yet — the pipeline uses the single key from your{' '}
            <code className="rounded bg-surface-2 px-1 font-mono text-xs">.env</code>. Add keys
            above to scale combined quota.
          </p>
        ) : (
          <div className="space-y-4">
            {KEY_PROVIDERS.map((p) => {
              const provKeys = rows.filter((k) => k.provider === p);
              if (provKeys.length === 0) return null;
              return (
                <div key={p}>
                  <div className="mb-2 flex items-center gap-2">
                    <span className="text-sm font-semibold capitalize">{p}</span>
                    <span className="text-xs text-fg-subtle">
                      {provKeys.length} {provKeys.length === 1 ? 'key' : 'keys'} pooled
                    </span>
                  </div>
                  <div className="divide-y divide-border overflow-hidden rounded-xl border border-border">
                    {provKeys.map((k) => (
                      <div
                        key={k.id}
                        className="flex items-center justify-between gap-3 px-3.5 py-2.5"
                      >
                        <div className="flex min-w-0 items-center gap-3">
                          <Dot tone={k.active ? 'success' : 'neutral'} />
                          <span className="font-mono text-sm">{k.masked}</span>
                          {k.label && (
                            <span className="truncate text-xs text-fg-subtle">{k.label}</span>
                          )}
                          {!k.active && <Badge tone="warning">paused</Badge>}
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <Button variant="ghost" size="sm" onClick={() => toggle(k)}>
                            {k.active ? 'Pause' : 'Resume'}
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => remove(k.id)}>
                            Delete
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </section>
  );
}

function StorageSection() {
  const qc = useQueryClient();
  const [clearing, setClearing] = useState<string | null>(null);
  const cache = useQuery<{ buckets: { bucket: string; bytes: number }[]; free: number }>({
    queryKey: ['cache'],
    queryFn: () => fetch('/api/cache').then((r) => r.json()),
  });

  async function clear(bucket: string) {
    setClearing(bucket);
    await fetch('/api/cache', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bucket }),
    }).catch(() => {});
    await qc.invalidateQueries({ queryKey: ['cache'] });
    setClearing(null);
  }

  const total = (cache.data?.buckets ?? []).reduce((s, b) => s + b.bytes, 0);

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Storage &amp; cache</h2>
        {cache.data && (
          <span className="text-xs text-fg-subtle">
            {fmtBytes(cache.data.free)} free · {fmtBytes(total)} cached
          </span>
        )}
      </div>
      {cache.isLoading ? (
        <Skeleton className="h-32" />
      ) : (
        <Card className="divide-y divide-border">
          {(cache.data?.buckets ?? []).map((b) => (
            <div
              key={b.bucket}
              className="flex items-center justify-between py-2.5 first:pt-0 last:pb-0"
            >
              <div>
                <span className="text-sm font-medium capitalize">{b.bucket.replace('-', ' ')}</span>
                <span className="ml-2 font-mono text-xs text-fg-subtle">{fmtBytes(b.bytes)}</span>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={clearing !== null || b.bytes === 0}
                onClick={() => clear(b.bucket)}
              >
                {clearing === b.bucket ? 'Clearing…' : 'Clear'}
              </Button>
            </div>
          ))}
        </Card>
      )}
      <p className="text-xs text-fg-subtle">
        The worker also evicts least-recently-used cached assets automatically when disk runs low.
      </p>
    </section>
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
