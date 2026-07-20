import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from '@scriptreel/config';
import { STAGES } from '@scriptreel/core';
import * as db from '@scriptreel/db';
import { NextResponse } from 'next/server';
import { enqueuePipeline } from '@/lib/queue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Re-run scoring WITH the vision (VLM) gate — e.g. after starting Ollama when it was skipped. The
// runner's only skip gate is a manifest hash match, so removing the score manifest forces score to
// re-run; 'full' then walks the pipeline (analyze/search/tts stay cached, no Chatterbox contention
// so the VLM gets the GPU) and re-pauses at review with freshly-verified selections. Runs on the
// shared worker, so pg-boss retries a briefly-unreachable sidecar instead of failing outright.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = await db.getProject(id);
  if (!project) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (project.status === 'queued' || project.status === 'running') {
    return NextResponse.json({ error: 'a run is already in progress' }, { status: 409 });
  }
  try {
    await rm(join(paths.projectDir(id), 'stages', 'score', 'manifest.json'), { force: true });
    await db.clearCancel(id);
    await db.setProjectStatus(id, 'queued');
    await db.ensurePipelineRuns(id, STAGES);
    await enqueuePipeline(id, 'full');
    return NextResponse.json({ ok: true }, { status: 202 });
  } catch (error) {
    return NextResponse.json({ error: 'rescore failed', detail: String(error) }, { status: 502 });
  }
}
