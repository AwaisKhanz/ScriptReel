import { NextResponse } from 'next/server';

// Thin proxy to the Python sidecar's /health (doc 19 §7.1). The web app itself
// loads no models; it only reports what the sidecar says.
export const dynamic = 'force-dynamic';

const SIDECAR_URL = process.env.SIDECAR_URL ?? 'http://127.0.0.1:8484';

export async function GET() {
  try {
    const res = await fetch(`${SIDECAR_URL}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) {
      return NextResponse.json(
        { ok: false, error: `sidecar responded ${res.status}` },
        { status: 502 },
      );
    }
    const body: unknown = await res.json();
    return NextResponse.json(body);
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: 'sidecar unreachable', detail: String(error) },
      { status: 502 },
    );
  }
}
