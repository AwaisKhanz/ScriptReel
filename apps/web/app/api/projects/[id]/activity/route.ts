import * as db from '@scriptreel/db';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Live pipeline activity (doc 16 realtime-via-poll): the media found so far, newest
// first. Polled by the run screen only while the project is active; one indexed query.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const thumbs = await db.getRecentCandidates(id, 24);
    return NextResponse.json({ thumbs });
  } catch (error) {
    return NextResponse.json({ error: 'db unavailable', detail: String(error) }, { status: 502 });
  }
}
