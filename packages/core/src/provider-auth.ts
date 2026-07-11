import type { ProviderId } from './providers';

// A scalable per-provider auth model (doc 23). Each provider declares the credential
// fields it needs (drives the admin form + storage) and — in the worker — how to turn
// those into request auth (a static key, or a refreshed OAuth token). Adding a new
// integration = one entry here + a resolver case + the provider module.

export interface CredentialField {
  name: string; // key in the stored credentials object
  label: string; // shown in the admin form
  secret: boolean; // masked in the UI and never returned to the client
  hint?: string;
}

// Empty array = keyless provider (not shown in the key manager).
export const PROVIDER_CREDENTIALS: Record<ProviderId, CredentialField[]> = {
  pexels: [{ name: 'apiKey', label: 'API key', secret: true }],
  pixabay: [{ name: 'apiKey', label: 'API key', secret: true }],
  openverse: [
    {
      name: 'clientId',
      label: 'Client ID',
      secret: false,
      hint: 'register at api.openverse.org/v1/auth_tokens/register',
    },
    { name: 'clientSecret', label: 'Client secret', secret: true },
  ],
  nasa: [], // keyless
  wikimedia: [], // keyless (Commons API is anonymous; a User-Agent is enough)
};

export type ProviderCredentials = Record<string, string>;

// How a resolved credential attaches to an outgoing request. The worker's auth
// resolver produces this (fetching/refreshing OAuth tokens as needed); providers
// just apply it — they never touch raw secrets or token flows.
export type RequestAuth =
  | { kind: 'none' }
  | { kind: 'header'; name: string; value: string }
  | { kind: 'query'; name: string; value: string };

// Attach the resolved auth to a request being built.
export function applyAuth(url: URL, headers: Record<string, string>, auth: RequestAuth): void {
  if (auth.kind === 'header') headers[auth.name] = auth.value;
  else if (auth.kind === 'query') url.searchParams.set(auth.name, auth.value);
}

// The fields the admin form should collect for a provider (empty = keyless).
export function credentialFields(provider: ProviderId): CredentialField[] {
  return PROVIDER_CREDENTIALS[provider] ?? [];
}
