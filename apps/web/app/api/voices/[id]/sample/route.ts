import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { env, paths } from '@scriptreel/config';
import { voiceById } from '@scriptreel/core';
import { NextResponse } from 'next/server';

// Voice preview (doc 10): stream cache/voice-samples/{id}.wav; synthesize once via
// the sidecar if missing. Warm (cached) requests are a fast file read.
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const voice = voiceById(id);
  if (!voice) {
    return NextResponse.json({ error: 'unknown voice' }, { status: 404 });
  }

  const cachePath = join(paths.cacheDir, 'voice-samples', `${id}.wav`);
  let wav: Buffer | null = await readFile(cachePath).catch(() => null);

  if (!wav) {
    // Route to whichever server owns this voice — the Chatterbox voice server for cloned narrators,
    // the sidecar for Kokoro. Same /tts contract, so the request body is identical.
    const baseUrl = voice.engine === 'chatterbox' ? env.CHATTERBOX_URL : env.SIDECAR_URL;
    const res = await fetch(`${baseUrl}/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: voice.sampleText,
        voice: id,
        langCode: voice.langCode,
        speed: 1.0,
        outPath: cachePath,
      }),
    });
    if (!res.ok) {
      return NextResponse.json({ error: 'voice synthesis failed' }, { status: 502 });
    }
    wav = await readFile(cachePath).catch(() => null);
    if (!wav) {
      return NextResponse.json({ error: 'sample not found after synthesis' }, { status: 502 });
    }
  }

  return new NextResponse(new Uint8Array(wav), {
    headers: { 'content-type': 'audio/wav', 'cache-control': 'public, max-age=86400' },
  });
}
