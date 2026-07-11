import * as db from '@scriptreel/db';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Set the cancel flag; the worker observes it between/within steps (doc 06) and
// resets the project to draft with manifests intact.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = await db.getProject(id);
  if (!project) return NextResponse.json({ error: 'not found' }, { status: 404 });
  try {
    await db.requestCancel(id);
    return NextResponse.json({ ok: true }, { status: 202 });
  } catch (error) {
    return NextResponse.json({ error: 'cancel failed', detail: String(error) }, { status: 502 });
  }
}
