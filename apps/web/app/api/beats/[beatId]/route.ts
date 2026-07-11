import * as db from '@scriptreel/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// {chosenCandidateId} to swap the chosen asset, {forcedTextcard} to pin a text card,
// or {segmentSwap:{index,candidateId}} to swap one montage shot (doc 23 §7b). All only
// while awaiting_review; the change invalidates fetch+compose via the fetch inputsHash
// (chosen candidate ids, forced textcards, and the segments plan).
const PatchSchema = z.union([
  z.object({ chosenCandidateId: z.string().uuid() }),
  z.object({ forcedTextcard: z.boolean() }),
  z.object({
    segmentSwap: z.object({
      index: z.number().int().nonnegative(),
      candidateId: z.string().uuid(),
    }),
  }),
]);

export async function PATCH(req: Request, { params }: { params: Promise<{ beatId: string }> }) {
  const { beatId } = await params;
  const owner = await db.getBeatOwner(beatId);
  if (!owner) return NextResponse.json({ error: 'beat not found' }, { status: 404 });
  if (owner.status !== 'awaiting_review') {
    return NextResponse.json({ error: 'project is not awaiting review' }, { status: 409 });
  }

  const parsed = PatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'expected {chosenCandidateId}, {forcedTextcard}, or {segmentSwap}' },
      { status: 400 },
    );
  }

  try {
    if ('chosenCandidateId' in parsed.data) {
      const belongs = await db.candidateBelongsToBeat(beatId, parsed.data.chosenCandidateId);
      if (!belongs) {
        return NextResponse.json(
          { error: 'candidate does not belong to this beat' },
          {
            status: 400,
          },
        );
      }
      await db.setBeatChosenCandidate(beatId, parsed.data.chosenCandidateId);
    } else if ('segmentSwap' in parsed.data) {
      const { index, candidateId } = parsed.data.segmentSwap;
      const belongs = await db.candidateBelongsToBeat(beatId, candidateId);
      if (!belongs) {
        return NextResponse.json(
          { error: 'candidate does not belong to this beat' },
          { status: 400 },
        );
      }
      const ok = await db.updateBeatSegment(beatId, index, candidateId);
      if (!ok) return NextResponse.json({ error: 'no such segment' }, { status: 400 });
    } else {
      await db.setBeatForcedTextcard(beatId, parsed.data.forcedTextcard);
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: 'update failed', detail: String(error) }, { status: 502 });
  }
}
