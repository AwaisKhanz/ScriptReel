import {
  applyAuth,
  interpretOpenverseRateLimit,
  PROVIDER_PROBE,
  type ProbeResult,
  type ProviderCredentials,
  type ProviderId,
  parseRateLimitHeaders,
  type RequestAuth,
} from '@scriptreel/core';
import * as db from '@scriptreel/db';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Per-key live "Test" (doc 23 §4): reach the provider with one key and report whether
// it works plus its TRUE limit — read from x-ratelimit-* headers (Pexels/Pixabay) or
// the Openverse rate_limit endpoint — not our estimate. One cheap request per test.
const OPENVERSE_TOKEN_URL = 'https://api.openverse.org/v1/auth_tokens/token/';
const UA = 'ScriptReel/1.0 (local script-to-video; key test)';

function httpDetail(status: number): string {
  if (status === 401 || status === 403) return 'rejected — key invalid or unauthorized';
  if (status === 429) return 'rate limited (429)';
  return `provider returned HTTP ${status}`;
}

// Static auth for header/query-key providers; null when a required key is missing.
function staticAuth(provider: ProviderId, creds: ProviderCredentials): RequestAuth | null {
  switch (provider) {
    case 'pexels':
      return creds.apiKey ? { kind: 'header', name: 'Authorization', value: creds.apiKey } : null;
    case 'pixabay':
      return creds.apiKey ? { kind: 'query', name: 'key', value: creds.apiKey } : null;
    default:
      return { kind: 'none' }; // nasa / wikimedia — keyless
  }
}

async function probeOpenverse(creds: ProviderCredentials): Promise<ProbeResult> {
  const base = { window: 'day' as const, resetAt: null, limit: null, remaining: null };
  if (!creds.clientId || !creds.clientSecret) {
    return { ok: false, status: 0, ...base, detail: 'missing client id / secret' };
  }
  // 1) The token exchange itself validates the credentials.
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
  });
  const tokRes = await fetch(OPENVERSE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!tokRes.ok) {
    return { ok: false, status: tokRes.status, ...base, detail: 'invalid client id / secret' };
  }
  const tok = (await tokRes.json()) as { access_token?: string };
  if (!tok.access_token) return { ok: false, status: tokRes.status, ...base, detail: 'no token' };

  // 2) Live usage + model tier from the rate_limit endpoint (a GET).
  const rlRes = await fetch(PROVIDER_PROBE.openverse.url, {
    method: 'GET',
    headers: { authorization: `Bearer ${tok.access_token}`, 'user-agent': UA },
    signal: AbortSignal.timeout(10_000),
  });
  if (!rlRes.ok) {
    return { ok: true, status: rlRes.status, ...base, detail: 'valid (rate_limit unavailable)' };
  }
  const info = interpretOpenverseRateLimit(await rlRes.json());
  return {
    ok: true,
    status: 200,
    window: 'day',
    resetAt: null,
    limit: info.limit,
    remaining: info.remaining,
    detail: info.detail,
  };
}

async function probe(provider: ProviderId, creds: ProviderCredentials): Promise<ProbeResult> {
  const spec = PROVIDER_PROBE[provider];
  if (provider === 'openverse') return probeOpenverse(creds);

  const auth = staticAuth(provider, creds);
  if (auth === null) {
    return {
      ok: false,
      status: 0,
      limit: null,
      remaining: null,
      resetAt: null,
      window: spec.window,
      detail: 'missing API key',
    };
  }

  const url = new URL(spec.url);
  const headers: Record<string, string> = { 'user-agent': UA };
  applyAuth(url, headers, auth);
  const res = await fetch(url, {
    method: spec.method,
    headers,
    signal: AbortSignal.timeout(12_000),
  });
  const base = { status: res.status, window: spec.window };
  if (!res.ok) {
    return {
      ok: false,
      ...base,
      limit: null,
      remaining: null,
      resetAt: null,
      detail: httpDetail(res.status),
    };
  }
  if (spec.limitSource === 'xratelimit-headers' && spec.resetKind) {
    const rl = parseRateLimitHeaders((n) => res.headers.get(n), spec.resetKind, Date.now());
    return { ok: true, ...base, ...rl };
  }
  return {
    ok: true,
    ...base,
    limit: null,
    remaining: null,
    resetAt: null,
    detail: 'no per-key limit published',
  };
}

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const key = await db.getProviderKey(id).catch(() => null);
  if (!key) return NextResponse.json({ error: 'not found' }, { status: 404 });
  try {
    const result = await probe(key.provider as ProviderId, key.creds);
    return NextResponse.json(result);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return NextResponse.json<ProbeResult>({
      ok: false,
      status: 0,
      limit: null,
      remaining: null,
      resetAt: null,
      window: null,
      detail: detail.includes('timeout') ? 'timed out reaching provider' : detail,
    });
  }
}
