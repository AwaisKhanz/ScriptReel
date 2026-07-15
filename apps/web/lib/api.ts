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
