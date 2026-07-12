import {
  applyAuth,
  interpretOpenverseRateLimit,
  PROVIDER_PROBE,
  type ProbeResult,
  type ProviderCredentials,
  type ProviderId,
  parseRateLimitHeaders,
} from '@scriptreel/core';
import * as db from '@scriptreel/db';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Per-key live "Test" (doc 23 §4): reach the provider with one key and report whether
// it works plus its TRUE limit — from x-ratelimit-* headers (Pexels/Pixabay/NASA), the
// Openverse rate_limit endpoint, or an OAuth token exchange (Openverse/Wikimedia) — not
// our estimate. One cheap request per test.
const OPENVERSE_TOKEN_URL = 'https://api.openverse.org/v1/auth_tokens/token/';
const WIKIMEDIA_TOKEN_URL = 'https://meta.wikimedia.org/w/rest.php/oauth2/access_token';
const NASA_VALIDATE_URL = 'https://api.nasa.gov/planetary/apod'; // honors api_key + x-ratelimit-*
const UA = 'ScriptReel/1.0 (local script-to-video; key test)';

const fail = (status: number, detail: string): ProbeResult => ({
  ok: false,
  status,
  limit: null,
  remaining: null,
  resetAt: null,
  window: null,
  detail,
});

function httpDetail(status: number): string {
  if (status === 401 || status === 403) return 'rejected — key invalid or unauthorized';
  if (status === 429) return 'rate limited (429)';
  return `provider returned HTTP ${status}`;
}

// Shared OAuth 2.0 client_credentials exchange — validates a client id/secret and
// returns a bearer token. Used by Openverse and Wikimedia (same grant, different URL).
async function exchangeClientCredentials(
  url: string,
  creds: ProviderCredentials,
): Promise<{ ok: boolean; status: number; token?: string }> {
  if (!creds.clientId || !creds.clientSecret) return { ok: false, status: 0 };
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
  });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return { ok: false, status: res.status };
  const json = (await res.json()) as { access_token?: string };
  return json.access_token
    ? { ok: true, status: res.status, token: json.access_token }
    : { ok: false, status: res.status };
}

// Header/query key providers: one cheap search call, read x-ratelimit-* if present.
async function probeStaticKey(provider: 'pexels' | 'pixabay', creds: ProviderCredentials) {
  if (!creds.apiKey) return fail(0, 'missing API key');
  const spec = PROVIDER_PROBE[provider];
  const url = new URL(spec.url);
  const headers: Record<string, string> = { 'user-agent': UA };
  applyAuth(
    url,
    headers,
    provider === 'pexels'
      ? { kind: 'header', name: 'Authorization', value: creds.apiKey }
      : { kind: 'query', name: 'key', value: creds.apiKey },
  );
  const res = await fetch(url, {
    method: spec.method,
    headers,
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) return fail(res.status, httpDetail(res.status));
  const rl = spec.resetKind
    ? parseRateLimitHeaders((n) => res.headers.get(n), spec.resetKind, Date.now())
    : { limit: null, remaining: null, resetAt: null };
  return { ok: true, status: res.status, window: spec.window, ...rl } satisfies ProbeResult;
}

async function probeNasa(creds: ProviderCredentials): Promise<ProbeResult> {
  // images-api.nasa.gov (what we search) is keyless/unmetered; an api.nasa.gov key
  // lifts limits + joins the rotation, and is validated against api.nasa.gov here.
  if (!creds.apiKey) {
    return {
      ok: true,
      status: 200,
      limit: null,
      remaining: null,
      resetAt: null,
      window: null,
      detail: 'anonymous — no per-key limit',
    };
  }
  const url = new URL(NASA_VALIDATE_URL);
  url.searchParams.set('api_key', creds.apiKey);
  const res = await fetch(url, {
    headers: { 'user-agent': UA },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) return fail(res.status, httpDetail(res.status));
  const rl = parseRateLimitHeaders((n) => res.headers.get(n), 'epoch', Date.now());
  return { ok: true, status: res.status, window: 'hour', ...rl };
}

async function probeOpenverse(creds: ProviderCredentials): Promise<ProbeResult> {
  const base = { window: 'day' as const, resetAt: null, limit: null, remaining: null };
  const tok = await exchangeClientCredentials(OPENVERSE_TOKEN_URL, creds);
  if (!creds.clientId || !creds.clientSecret) return fail(0, 'missing client id / secret');
  if (!tok.ok || !tok.token)
    return { ok: false, status: tok.status, ...base, detail: 'invalid client id / secret' };

  // Live usage + model tier from the rate_limit endpoint (a GET).
  const rlRes = await fetch(PROVIDER_PROBE.openverse.url, {
    method: 'GET',
    headers: { authorization: `Bearer ${tok.token}`, 'user-agent': UA },
    signal: AbortSignal.timeout(10_000),
  });
  if (!rlRes.ok)
    return { ok: true, status: rlRes.status, ...base, detail: 'valid (rate_limit unavailable)' };
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

async function probeWikimedia(creds: ProviderCredentials): Promise<ProbeResult> {
  if (!creds.clientId || !creds.clientSecret) return fail(0, 'missing client id / secret');
  const tok = await exchangeClientCredentials(WIKIMEDIA_TOKEN_URL, creds);
  if (!tok.ok || !tok.token) return { ...fail(tok.status, 'invalid client id / secret') };
  // Commons read isn't metered per key; the valid token grants the higher rate tier.
  return {
    ok: true,
    status: 200,
    limit: null,
    remaining: null,
    resetAt: null,
    window: null,
    detail: 'authenticated (higher limits)',
  };
}

function probe(provider: ProviderId, creds: ProviderCredentials): Promise<ProbeResult> {
  switch (provider) {
    case 'pexels':
    case 'pixabay':
      return probeStaticKey(provider, creds);
    case 'nasa':
      return probeNasa(creds);
    case 'openverse':
      return probeOpenverse(creds);
    case 'wikimedia':
      return probeWikimedia(creds);
    default:
      // Keyless providers (e.g. wikidata-commons) have no stored key to test.
      return Promise.resolve(fail(0, 'provider has no testable key'));
  }
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
    return NextResponse.json(
      fail(0, detail.includes('timeout') ? 'timed out reaching provider' : detail),
    );
  }
}
