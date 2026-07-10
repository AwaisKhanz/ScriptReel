import { env } from '@scriptreel/config';
import { defaultVoiceForLanguage } from '@scriptreel/core';
import { NextResponse } from 'next/server';

// Warm the Kokoro pipeline for a language so subsequent sample requests are quick
// (doc 10 — pre-warm on language change).
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const body: unknown = await req.json().catch(() => ({}));
  const language =
    typeof body === 'object' && body && 'language' in body ? String(body.language) : '';
  const langCode = defaultVoiceForLanguage(language)?.langCode;
  if (!langCode) {
    return NextResponse.json({ error: 'unknown language' }, { status: 400 });
  }
  const res = await fetch(`${env.SIDECAR_URL}/warmup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ langs: [langCode] }),
  });
  return NextResponse.json({ ok: res.ok, langCode });
}
