import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { env, paths } from '@scriptreel/config';
import { NextResponse } from 'next/server';

// Model playground (dev/diagnostic — NOT part of the script pipeline). Saves the uploaded
// image(s) under DATA_DIR/cache/playground (a path the sidecar can read on the same
// machine), then fans out to the sidecar's model endpoints. Each model is isolated so one
// that's not installed (e.g. VLM before `make fetch-vlm`) doesn't break the others.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PLAYGROUND_DIR = join(paths.cacheDir, 'playground');
const FAST_MS = 30_000; // OCR / embeds
const VLM_MS = 300_000; // VLM loads ~2.2 GB on demand — give it room

type SafeResult<T> = { ok: true; data: T } | { ok: false; error: string };

async function safe<T>(fn: () => Promise<T>): Promise<SafeResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function saveUpload(file: File): Promise<string> {
  await mkdir(PLAYGROUND_DIR, { recursive: true });
  const ext = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg';
  const outPath = join(PLAYGROUND_DIR, `${randomUUID()}.${ext}`);
  await writeFile(outPath, Buffer.from(await file.arrayBuffer()));
  return outPath;
}

// L2-normalized vectors from the sidecar ⇒ cosine is the dot product; guard length + norm.
function cosine(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

async function postSidecar<T>(path: string, body: unknown, ms: number): Promise<T> {
  const res = await fetch(`${env.SIDECAR_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(ms),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
    throw new Error(err?.error?.code ?? `sidecar ${path} → HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

interface EmbedResp {
  vectors: number[][];
  dim: number;
  failed?: string[];
}

export async function POST(request: Request): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: 'expected multipart/form-data' }, { status: 400 });
  }

  const imageA = form.get('imageA');
  const imageB = form.get('imageB');
  const text = (typeof form.get('text') === 'string' ? (form.get('text') as string) : '').trim();
  const eraRaw = typeof form.get('era') === 'string' ? (form.get('era') as string) : 'timeless';
  const era = ['modern', 'historical', 'timeless'].includes(eraRaw) ? eraRaw : 'timeless';

  if (!(imageA instanceof File) || imageA.size === 0) {
    return NextResponse.json({ error: 'imageA is required' }, { status: 400 });
  }

  const pathA = await saveUpload(imageA);
  const pathB = imageB instanceof File && imageB.size > 0 ? await saveUpload(imageB) : null;

  // OCR — always, on image A.
  const ocr = await safe(async () => {
    const r = await postSidecar<{ results: unknown[]; failed: string[] }>(
      '/ocr',
      { paths: [pathA] },
      FAST_MS,
    );
    return (r.results[0] as { text: string; coverage: number; wordCount: number }) ?? null;
  });

  // SigLIP — embed A (+ B), (+ text): image↔text and image↔image cosine.
  const siglip = await safe(async () => {
    const imgPaths = pathB ? [pathA, pathB] : [pathA];
    const img = await postSidecar<EmbedResp>('/embed/image', { paths: imgPaths }, FAST_MS);
    const vecA = img.vectors[0] ?? [];
    const out: { dim: number; textSim: number | null; imageSim: number | null } = {
      dim: img.dim,
      textSim: null,
      imageSim: null,
    };
    if (text) {
      const t = await postSidecar<EmbedResp>('/embed/text', { texts: [text] }, FAST_MS);
      if (t.vectors[0]) out.textSim = cosine(vecA, t.vectors[0]);
    }
    if (pathB && img.vectors[1]) out.imageSim = cosine(vecA, img.vectors[1]);
    return out;
  });

  // DINOv2 — image↔image identity (needs a reference image B).
  const dino = pathB
    ? await safe(async () => {
        const r = await postSidecar<EmbedResp>('/dino/embed', { paths: [pathA, pathB] }, FAST_MS);
        const failed = new Set(r.failed ?? []);
        const both = !failed.has(pathA) && !failed.has(pathB) && r.vectors[0] && r.vectors[1];
        return { dim: r.dim, sim: both ? cosine(r.vectors[0] ?? [], r.vectors[1] ?? []) : null };
      })
    : null;

  // InsightFace — face↔face identity (needs a reference image B).
  const face = pathB
    ? await safe(async () => {
        const r = await postSidecar<EmbedResp>('/face/embed', { paths: [pathA, pathB] }, FAST_MS);
        const failed = new Set(r.failed ?? []);
        const faceInA = !failed.has(pathA);
        const faceInB = !failed.has(pathB);
        return {
          faceInA,
          faceInB,
          sim: faceInA && faceInB ? cosine(r.vectors[0] ?? [], r.vectors[1] ?? []) : null,
        };
      })
    : null;

  // VLM checklist — needs a description (the text field doubles as the subject).
  const vlm = text
    ? await safe(async () => {
        const r = await postSidecar<{
          results: {
            subjectPresent: boolean;
            shotTypeMatches: boolean;
            eraMatches: boolean;
            contradictingText: boolean;
          }[];
          failed: string[];
        }>('/vlm', { items: [{ path: pathA, description: text, era }] }, VLM_MS);
        if (r.results[0]) return r.results[0];
        throw new Error('the model returned no parseable answer for this image');
      })
    : null;

  return NextResponse.json({ ocr, siglip, dino, face, vlm });
}
