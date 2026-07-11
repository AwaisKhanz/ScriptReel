import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { env } from '@scriptreel/config';
import { sql } from '@scriptreel/db';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const run = promisify(execFile);

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

async function checkDb() {
  try {
    await withTimeout(sql`select 1`, 2000);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function checkSidecar() {
  try {
    const res = await withTimeout(fetch(`${env.SIDECAR_URL}/health`), 2000);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const body = (await res.json()) as { device?: string; models?: Record<string, string> };
    return { ok: true, device: body.device, models: body.models };
  } catch {
    return { ok: false, error: 'unreachable' };
  }
}

async function checkFfmpeg() {
  try {
    const bin = env.FFMPEG_PATH ?? 'ffmpeg';
    const { stdout } = await withTimeout(run(bin, ['-version']), 2000);
    const major = Number(/ffmpeg version (\d+)/.exec(stdout)?.[1] ?? 0);
    return {
      ok: major >= 6 && stdout.includes('libass'),
      version: major,
      libass: stdout.includes('libass'),
    };
  } catch {
    return { ok: false, error: 'not found' };
  }
}

function checkKeys() {
  return {
    ok: Boolean(env.PEXELS_API_KEY && env.PIXABAY_API_KEY && env.OPENAI_API_KEY),
    pexels: Boolean(env.PEXELS_API_KEY),
    pixabay: Boolean(env.PIXABAY_API_KEY),
    openai: Boolean(env.OPENAI_API_KEY),
  };
}

export async function GET() {
  const [db, sidecar, ffmpeg] = await Promise.all([checkDb(), checkSidecar(), checkFfmpeg()]);
  const keys = checkKeys();
  const ok = db.ok && sidecar.ok && ffmpeg.ok && keys.ok;
  return NextResponse.json({ ok, checks: { db, sidecar, ffmpeg, keys } });
}
