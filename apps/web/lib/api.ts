// Shared client-side API error reader. Every API route returns `{ error, detail? }` on failure:
// `error` is a short label ("create failed"), `detail` carries the REAL underlying cause — a
// Postgres constraint message, a sidecar `E_*` code, a stack string. The UI should surface
// `detail` so a failure shows exactly what went wrong instead of a generic label (that generic
// label is why a `projects_script_check` violation looked like a plain "create failed").
//
// Call this only on a response you've confirmed is `!res.ok` and whose body you have NOT already
// read — it consumes the body. Safe on any shape (non-JSON / empty → falls back to the status).
export async function apiError(res: Response, fallback = 'request failed'): Promise<Error> {
  try {
    const body: unknown = await res.json();
    if (body && typeof body === 'object') {
      const { detail, error } = body as { detail?: unknown; error?: unknown };
      const msg = detail ?? error;
      if (msg != null && String(msg).length > 0) return new Error(String(msg));
    }
  } catch {
    // non-JSON or empty body — fall through to the status line
  }
  return new Error(`${fallback} (HTTP ${res.status})`);
}

// GET a JSON route, THROWING on a non-2xx instead of resolving with the error body.
//
// `fetch(url).then(r => r.json())` — the shape every queryFn in this app used — resolves
// successfully for a 502, handing TanStack Query `{error: 'db unavailable'}` as if it were data.
// isError never fires, so `data?.projects ?? []` renders the empty state: with the database down
// the dashboard said "No projects yet — Your first video is a paste away." A user cannot tell that
// apart from actually having no projects, which is the worst possible failure for a status screen.
// Throwing is what lets isError, the retry, and every ErrorCard in the app work at all.
export async function getJson<T>(url: string, fallback = 'request failed'): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw await apiError(res, fallback);
  return (await res.json()) as T;
}
