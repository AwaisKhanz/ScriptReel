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

// Fields a provider needs. Empty array ⇒ purely keyless (never shown in the key
// manager). NASA and Wikimedia also work anonymously, but accept optional credentials
// to lift their rate limits and to join the pooled rotation (doc 23 §4).
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
  nasa: [{ name: 'apiKey', label: 'API key', secret: true, hint: 'get a key at api.nasa.gov' }],
  wikimedia: [
    {
      name: 'clientId',
      label: 'Client ID',
      secret: false,
      hint: 'OAuth 2.0 consumer at meta.wikimedia.org/wiki/Special:OAuthConsumerRegistration',
    },
    { name: 'clientSecret', label: 'Client secret', secret: true },
  ],
  // Keyless: Wikidata + Commons resolution needs only a descriptive User-Agent (doc 24
  // §4). Empty ⇒ never shown in the key manager, never addable.
  'wikidata-commons': [],
  // Keyless: the Met Collection API takes no key (doc 25 §2). Empty ⇒ never shown in the
  // key manager, never addable.
  met: [],
  // Keyless: the Internet Archive advancedsearch/metadata APIs take no key (doc 25 §2).
  // Empty ⇒ never shown in the key manager, never addable.
  'internet-archive': [],
  // Keyless: the iNaturalist observations API takes no key (doc 25 §2). Empty ⇒ never
  // shown in the key manager, never addable.
  inaturalist: [],
  // Keyless: the USGS ScienceBase catalog takes no key (doc 25 §2). Empty ⇒ never shown
  // in the key manager, never addable.
  usgs: [],
  // Keyless: the Library of Congress JSON API takes no key (doc 25 §2). Empty ⇒ never
  // shown in the key manager, never addable.
  'library-of-congress': [],
  // Keyed: Flickr photo search takes a query api_key (doc 25 §2).
  flickr: [
    {
      name: 'apiKey',
      label: 'API key',
      secret: true,
      hint: 'Free instant key at flickr.com/services/apps/create/apply — paste the Key (no secret needed for search).',
    },
  ],
  // Keyed: Europeana search takes a query wskey (doc 25 §2).
  europeana: [
    {
      name: 'apiKey',
      label: 'API key',
      secret: true,
      hint: 'Free key (wskey) from pro.europeana.eu/pages/get-api-keys — emailed.',
    },
  ],
  // Keyed: Smithsonian Open Access takes an api.data.gov api_key (doc 25 §2).
  smithsonian: [
    {
      name: 'apiKey',
      label: 'API key',
      secret: true,
      hint: 'Free instant api.data.gov key (api.data.gov/signup) — one key covers Smithsonian Open Access.',
    },
  ],
  // Keyless: the Wellcome Collection catalogue API takes no key. Empty ⇒ never shown in the key
  // manager, never addable.
  wellcome: [],
};

// Providers that accept pooled credentials (i.e. declare ≥1 field) — the single source
// of truth for the admin API's allow-list and the Settings key manager (no per-provider
// UI lists to keep in sync).
export const KEYED_PROVIDERS: readonly ProviderId[] = (
  Object.keys(PROVIDER_CREDENTIALS) as ProviderId[]
).filter((p) => PROVIDER_CREDENTIALS[p].length > 0);

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
