import { rm } from 'node:fs/promises';
import { paths } from '@scriptreel/config';
import { overallProgress } from '@scriptreel/core';
import * as db from '@scriptreel/db';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// {project, runs, overall, renders} — the workspace's single source of truth. The
// client polls this while the run is active (doc 16 realtime-via-poll).
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const project = await db.getProject(id);
    if (!project) return NextResponse.json({ error: 'not found' }, { status: 404 });
    const [runs, renders] = await Promise.all([db.getPipelineRuns(id), db.getRenders(id)]);
    return NextResponse.json({
      project,
      runs,
      overall: overallProgress(runs),
      renders,
    });
  } catch (error) {
    return NextResponse.json({ error: 'db unavailable', detail: String(error) }, { status: 502 });
  }
}

// Cascade-delete the project rows (FK on delete cascade) and rm its on-disk tree
// (never touches cache/). Refused while a job is in flight (doc 15).
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const project = await db.getProject(id);
    if (!project) return NextResponse.json({ error: 'not found' }, { status: 404 });
    if (project.status === 'queued' || project.status === 'running') {
      return NextResponse.json(
        { error: 'cancel the running job before deleting' },
        { status: 409 },
      );
    }
    await db.deleteProject(id);
    await rm(paths.projectDir(id), { recursive: true, force: true });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: 'delete failed', detail: String(error) }, { status: 502 });
  }
}
