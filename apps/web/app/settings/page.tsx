'use client';

import { credentialFields, KEYED_PROVIDERS, type ProviderId } from '@scriptreel/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Pills } from '../../components/controls';
import { Badge, Button, Card, Dot, ProgressBar, Skeleton, Spinner } from '../../components/ui';
import { fmtBytes } from '../../lib/format';

interface Health {
  ok: boolean;
  checks: {
    db: { ok: boolean };
    sidecar: { ok: boolean; device?: string; models?: Record<string, string> };
    ffmpeg: { ok: boolean; version?: number; libass?: boolean };
    keys: { ok: boolean; llm: string; openai: boolean; providerKeys: number };
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
interface FieldView {
  name: string;
  label: string;
  secret: boolean;
  value: string; // masked for secret fields, plain for public ones
}
interface KeyRow {
  id: string;
  provider: string;
  label: string | null;
  active: boolean;
  fields: FieldView[];
}
// Providers that accept pooled credentials — the single source of truth is core's
// KEYED_PROVIDERS (derived from PROVIDER_CREDENTIALS), so no list to keep in sync.
const KEY_PROVIDERS = KEYED_PROVIDERS;
const PROVIDER_OPTIONS = KEY_PROVIDERS.map((p) => ({
  value: p,
  label: p.charAt(0).toUpperCase() + p.slice(1),
}));
const PROVIDER_HELP: Record<string, string> = {
  pexels: 'https://www.pexels.com/api/',
  pixabay: 'https://pixabay.com/api/docs/',
  openverse: 'https://api.openverse.org/v1/auth_tokens/register/',
  nasa: 'https://api.nasa.gov/',
  wikimedia: 'https://meta.wikimedia.org/wiki/Special:OAuthConsumerRegistration',
};
// Providers usable without a key — the field is optional (raises limits / joins rotation).
const PROVIDER_NOTE: Record<string, string> = {
  openverse:
    'Optional — Openverse works anonymously (200/day). Adding an app id + secret raises the limit; the worker exchanges them for a 12-hour token and refreshes it automatically.',
  nasa: 'Optional — NASA image search works without a key. An api.nasa.gov key lifts limits and lets the account join the pooled rotation.',
  wikimedia:
    'Optional — Wikimedia Commons works anonymously. An OAuth 2.0 consumer (client id + secret) raises rate limits; the worker exchanges them for a bearer token automatically.',
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
              title="LLM & keys"
              ok={health.data?.checks.keys.ok}
              detail={
                health.data
                  ? `LLM: ${health.data.checks.keys.llm} · ${health.data.checks.keys.providerKeys} provider key${
                      health.data.checks.keys.providerKeys === 1 ? '' : 's'
                    }`
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
        ) : quota.data?.meters?.length ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {quota.data?.meters?.map((m) => {
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
        ) : (
          <p className="text-sm text-fg-muted">
            Quota is unavailable right now — try again shortly.
          </p>
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
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keys = useQuery<{ keys: KeyRow[] }>({
    queryKey: ['keys'],
    queryFn: () => fetch('/api/keys').then((r) => r.json()),
  });

  // The credential fields for the selected provider drive the whole form —
  // one API key, or an OAuth id + secret pair, etc. (doc 23 auth model).
  const fields = useMemo(() => credentialFields(provider as ProviderId), [provider]);

  function selectProvider(p: string) {
    setProvider(p);
    setCreds({}); // fields differ per provider — never carry a stale value across
    setError(null);
  }

  async function add() {
    for (const f of fields) {
      if ((creds[f.name]?.trim().length ?? 0) < 4) {
        setError(`Enter a valid ${f.label.toLowerCase()}`);
        return;
      }
    }
    setBusy(true);
    setError(null);
    const credentials = Object.fromEntries(
      fields.map((f) => [f.name, creds[f.name]?.trim() ?? '']),
    );
    const res = await fetch('/api/keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider, credentials, label: label.trim() || undefined }),
    });
    if (res.ok) {
      setCreds({});
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
              get {provider} credentials
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
            <Pills value={provider} options={PROVIDER_OPTIONS} onChange={selectProvider} />
          </div>
          <div className="mt-3 space-y-2">
            {fields.map((f) => (
              <div key={f.name}>
                <label
                  htmlFor={`cred-${provider}-${f.name}`}
                  className="mb-1 block text-xs font-medium text-fg-muted"
                >
                  {f.label}
                  {f.hint && <span className="ml-1.5 font-normal text-fg-subtle">— {f.hint}</span>}
                </label>
                <input
                  id={`cred-${provider}-${f.name}`}
                  type={f.secret ? 'password' : 'text'}
                  autoComplete="off"
                  value={creds[f.name] ?? ''}
                  onChange={(e) => setCreds((c) => ({ ...c, [f.name]: e.target.value }))}
                  onKeyDown={(e) => e.key === 'Enter' && add()}
                  placeholder={`paste ${f.label.toLowerCase()}…`}
                  className="h-10 w-full rounded-lg border border-border bg-bg px-3 font-mono text-sm outline-none transition-colors focus:border-accent/50 focus:ring-2 focus:ring-accent/25"
                />
              </div>
            ))}
            <div className="flex flex-col gap-2 pt-1 sm:flex-row">
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && add()}
                placeholder="label (optional — e.g. account 2)"
                className="h-10 flex-1 rounded-lg border border-border bg-bg px-3 text-sm outline-none transition-colors focus:border-accent/50"
              />
              <Button variant="primary" disabled={busy} onClick={add}>
                {busy ? <Spinner /> : 'Add key'}
              </Button>
            </div>
          </div>
          {PROVIDER_NOTE[provider] && (
            <p className="mt-2 text-xs text-fg-subtle">{PROVIDER_NOTE[provider]}</p>
          )}
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
                      <KeyRowItem key={k.id} k={k} onToggle={toggle} onRemove={remove} />
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

interface ProbeResult {
  ok: boolean;
  status: number;
  limit: number | null;
  remaining: number | null;
  resetAt: string | null;
  window: string | null;
  detail?: string;
}

// One pooled key: shows its masked credentials and — on Test — a live validity + real
// limit chip read straight from the provider (doc 23 §4). Local state per row.
function KeyRowItem({
  k,
  onToggle,
  onRemove,
}: {
  k: KeyRow;
  onToggle: (k: KeyRow) => void;
  onRemove: (id: string) => void;
}) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<ProbeResult | null>(null);

  async function test() {
    setTesting(true);
    setResult(null);
    try {
      const res = await fetch(`/api/keys/${k.id}/test`, { method: 'POST' });
      setResult(await res.json());
    } catch {
      setResult({
        ok: false,
        status: 0,
        limit: null,
        remaining: null,
        resetAt: null,
        window: null,
        detail: 'request failed',
      });
    }
    setTesting(false);
  }

  return (
    <div className="flex items-center justify-between gap-3 px-3.5 py-2.5">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <Dot tone={k.active ? 'success' : 'neutral'} />
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-sm">
          {k.fields.map((f, i) => (
            <span key={f.name} className="inline-flex items-center gap-1.5">
              {i > 0 && <span className="text-fg-subtle">·</span>}
              {k.fields.length > 1 && <span className="text-[11px] text-fg-subtle">{f.label}</span>}
              <span className="truncate">{f.value}</span>
            </span>
          ))}
        </span>
        {k.label && <span className="truncate text-xs text-fg-subtle">{k.label}</span>}
        {!k.active && <Badge tone="warning">paused</Badge>}
        {result && <TestResult r={result} />}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button variant="ghost" size="sm" disabled={testing} onClick={test}>
          {testing ? <Spinner /> : 'Test'}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => onToggle(k)}>
          {k.active ? 'Pause' : 'Resume'}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => onRemove(k.id)}>
          Delete
        </Button>
      </div>
    </div>
  );
}

// Short reset hint from the provider's real reset time: a clock for < 24 h, a date
// beyond — so we never mislabel a monthly window as hourly.
function resetHint(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hoursOut = (d.getTime() - Date.now()) / 3_600_000;
  return hoursOut <= 24
    ? ` · resets ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    : ` · resets ${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
}

function TestResult({ r }: { r: ProbeResult }) {
  if (!r.ok) return <Badge tone="danger">✗ {r.detail ?? 'invalid'}</Badge>;

  // Three truthful shapes: live remaining/limit, a bare cap (usage unknown), or no cap.
  let limitText = '';
  if (r.limit != null && r.remaining != null) {
    limitText = `${r.remaining.toLocaleString()}/${r.limit.toLocaleString()} left`;
    limitText += r.resetAt ? resetHint(r.resetAt) : r.window ? ` per ${r.window}` : '';
  } else if (r.limit != null) {
    limitText = `up to ${r.limit.toLocaleString()}${r.window ? ` / ${r.window}` : ''}`;
  }

  return (
    <Badge tone="success">
      <Dot tone="success" />
      valid
      {limitText && <span className="ml-1 font-mono text-[11px]">{limitText}</span>}
      {r.detail && !limitText.includes(r.detail) && (
        <span className="ml-1 text-[11px] opacity-80">{r.detail}</span>
      )}
    </Badge>
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
