import type { ProviderCredentials, ProviderId, RequestAuth } from '@scriptreel/core';

// Turns a pooled key's stored credentials into request auth (doc 23). Static keys
// map straight through; OAuth providers exchange client credentials for a bearer
// token and cache/refresh it. Providers never see this flow — they get RequestAuth.

const OPENVERSE_TOKEN_URL = 'https://api.openverse.org/v1/auth_tokens/token/';

// clientId → { token, expiresAt(ms) }. Process-lifetime cache (the worker is long
// lived); Openverse tokens last ~12 h, we refresh 60 s early.
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

export async function resolveAuth(
  provider: ProviderId,
  creds: ProviderCredentials,
): Promise<RequestAuth> {
  switch (provider) {
    case 'pexels':
      return creds.apiKey
        ? { kind: 'header', name: 'Authorization', value: creds.apiKey }
        : { kind: 'none' };
    case 'pixabay':
      return creds.apiKey ? { kind: 'query', name: 'key', value: creds.apiKey } : { kind: 'none' };
    case 'openverse': {
      if (!creds.clientId || !creds.clientSecret) return { kind: 'none' }; // anonymous
      const token = await openverseToken(creds.clientId, creds.clientSecret);
      return { kind: 'header', name: 'Authorization', value: `Bearer ${token}` };
    }
    default:
      return { kind: 'none' }; // nasa + anything keyless
  }
}

async function openverseToken(clientId: string, clientSecret: string): Promise<string> {
  const cached = tokenCache.get(clientId);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  });
  const res = await fetch(OPENVERSE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`openverse token exchange → HTTP ${res.status}`);
  const json = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache.set(clientId, {
    token: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  });
  return json.access_token;
}
