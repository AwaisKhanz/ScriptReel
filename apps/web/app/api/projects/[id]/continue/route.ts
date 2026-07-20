import * as db from '@scriptreel/db';
import { NextResponse } from 'next/server';
import { enqueuePipeline } from '@/lib/queue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = await db.getProject(id);
  if (!project) return NextResponse.json({ error: 'not found' }, { status: 404 });
  // 'awaiting_review' → approve the storyboard and render. 'done' → re-render after per-beat clip
  // swaps: `continue` re-runs [fetch, align, compose] idempotently, re-stitching just the beats
  // whose pick changed. Any other status means a run is in flight (or nothing to continue).
  if (project.status !== 'awaiting_review' && project.status !== 'done') {
    return NextResponse.json({ error: 'not awaiting review or done' }, { status: 409 });
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
