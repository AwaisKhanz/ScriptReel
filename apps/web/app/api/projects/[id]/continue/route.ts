import * as db from '@scriptreel/db';
import { NextResponse } from 'next/server';
import { enqueuePipeline } from '@/lib/queue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = await db.getProject(id);
  if (!project) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (project.status !== 'awaiting_review') {
    return NextResponse.json({ error: 'not awaiting review' }, { status: 409 });
  }
  try {
    await db.clearCancel(id);
    await db.setProjectStatus(id, 'queued');
    await enqueuePipeline(id, 'continue');
    return NextResponse.json({ ok: true }, { status: 202 });
  } catch (error) {
    return NextResponse.json({ error: 'enqueue failed', detail: String(error) }, { status: 502 });
  }
}
