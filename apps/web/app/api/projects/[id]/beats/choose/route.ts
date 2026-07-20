import * as db from '@scriptreel/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ChooseSchema = z.object({ beatId: z.string().min(1), candidateId: z.string().min(1) });

// Manual per-beat clip swap (storyboard). Persists the pick ONLY — the render is a separate action
// (Approve at review, or "Re-render with changes" when done), so several swaps batch into one
// render. Changing the pick shifts fetch's inputsHash, so the next continue re-stitches just this
// beat and recomposes.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = await db.getProject(id);
  if (!project) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const parsed = ChooseSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid body' },
      { status: 400 },
    );
  }
  const { beatId, candidateId } = parsed.data;

  // Authz: the beat must belong to THIS project (candidate-belongs-to-beat is checked in the query).
  if (!(await db.beatBelongsToProject(beatId, id))) {
    return NextResponse.json({ error: 'beat not in project' }, { status: 404 });
  }
  try {
    await db.setBeatChosenCandidate(beatId, candidateId);
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (error) {
    return NextResponse.json({ error: 'swap failed', detail: String(error) }, { status: 400 });
  }
}
