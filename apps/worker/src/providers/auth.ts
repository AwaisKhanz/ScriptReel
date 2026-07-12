import type { ProviderCredentials, ProviderId, RequestAuth } from '@scriptreel/core';

// Turns a pooled key's stored credentials into request auth (doc 23). Static keys map
// straight through (header/query); OAuth 2.0 providers exchange client credentials for
// a bearer token via the client_credentials grant and cache/refresh it. Providers never
// see this flow — they get a resolved RequestAuth.

// OAuth 2.0 client_credentials token endpoints, keyed by provider.
const OAUTH_TOKEN_URL: Partial<Record<ProviderId, string>> = {
  openverse: 'https://api.openverse.org/v1/auth_tokens/token/',
  wikimedia: 'https://meta.wikimedia.org/w/rest.php/oauth2/access_token',
};

// `${provider}:${clientId}` → { token, expiresAt(ms) }. Process-lifetime cache (the
// worker is long lived); refreshed 60 s before expiry.
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
    case 'nasa':
      // Optional api.nasa.gov key; anonymous otherwise. images-api ignores it but
      // api.nasa.gov honors it, and it lets the key join the pooled rotation.
      return creds.apiKey
        ? { kind: 'query', name: 'api_key', value: creds.apiKey }
        : { kind: 'none' };
    case 'openverse':
    case 'wikimedia': {
      if (!creds.clientId || !creds.clientSecret) return { kind: 'none' }; // anonymous
      const token = await oauthToken(provider, creds.clientId, creds.clientSecret);
      return { kind: 'header', name: 'Authorization', value: `Bearer ${token}` };
    }
    case 'flickr':
      // Flickr photos.search takes the key as an `api_key` query param (doc 25 §2).
      return creds.apiKey
        ? { kind: 'query', name: 'api_key', value: creds.apiKey }
        : { kind: 'none' };
    case 'europeana':
      // Europeana search takes the key as a `wskey` query param (doc 25 §2).
      return creds.apiKey
        ? { kind: 'query', name: 'wskey', value: creds.apiKey }
        : { kind: 'none' };
    case 'smithsonian':
      // Smithsonian Open Access takes the api.data.gov key as an `api_key` query param.
      return creds.apiKey
        ? { kind: 'query', name: 'api_key', value: creds.apiKey }
        : { kind: 'none' };
    default:
      return { kind: 'none' };
  }
}

// OAuth 2.0 client_credentials grant, cached until ~expiry. Openverse and Wikimedia
// share the exact flow, differing only by token endpoint.
async function oauthToken(
  provider: ProviderId,
  clientId: string,
  clientSecret: string,
): Promise<string> {
  const url = OAUTH_TOKEN_URL[provider];
  if (!url) throw new Error(`no OAuth token endpoint for ${provider}`);
  const cacheKey = `${provider}:${clientId}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`${provider} token exchange → HTTP ${res.status}`);
  const json = (await res.json()) as { access_token: string; expires_in?: number };
  // Some issuers omit expires_in for client_credentials; default to 1 h and refresh.
  const ttlSec = json.expires_in ?? 3600;
  tokenCache.set(cacheKey, { token: json.access_token, expiresAt: Date.now() + ttlSec * 1000 });
  return json.access_token;
}
