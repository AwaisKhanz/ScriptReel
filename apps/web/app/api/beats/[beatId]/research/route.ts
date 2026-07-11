import { QUOTA_BUDGETS, truncateWindow } from '@scriptreel/core';
import * as db from '@scriptreel/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { enqueueBeatResearch } from '@/lib/queue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// A single-beat re-search costs ≤ 4 provider requests (video+image on Pexels+Pixabay,
// doc 22). Require ≥ 2 remaining on each provider's tightest window so a re-search can
// never overrun the budget.
const RESEARCH_COST_PER_PROVIDER = 2;

const ResearchSchema = z.object({
  visualDescription: z.string().min(1).max(300).optional(),
  customQuery: z.string().min(1).max(120).optional(),
});

async function remaining(key: string, unit: 'hour' | 'month' | 'minute'): Promise<number> {
  const budget = QUOTA_BUDGETS.find((b) => b.key === key)?.budget ?? 0;
  const used = await db.getProviderUsage(key, truncateWindow(new Date(), unit));
  return Math.max(0, budget - used);
}

export async function POST(req: Request, { params }: { params: Promise<{ beatId: string }> }) {
  const { beatId } = await params;
  const owner = await db.getBeatOwner(beatId);
  if (!owner) return NextResponse.json({ error: 'beat not found' }, { status: 404 });
  if (owner.status !== 'awaiting_review') {
    return NextResponse.json({ error: 'project is not awaiting review' }, { status: 409 });
  }

  const parsed = ResearchSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }

  // Quota guard (doc 15): 429 when either provider is below the re-search reserve.
  const [pexelsHour, pixabayMinute] = await Promise.all([
    remaining('pexels:hour', 'hour'),
    remaining('pixabay:minute', 'minute'),
  ]);
  if (pexelsHour < RESEARCH_COST_PER_PROVIDER && pixabayMinute < RESEARCH_COST_PER_PROVIDER) {
    return NextResponse.json(
      {
        error:
          'Provider quota is too low to re-search right now. It frees up as the windows reset.',
        pexelsHour,
        pixabayMinute,
      },
      { status: 429 },
    );
  }

  try {
    if (parsed.data.visualDescription) {
      await db.setBeatVisualDescription(beatId, parsed.data.visualDescription);
    }
    const jobId = await enqueueBeatResearch({
      projectId: owner.projectId,
      beatId,
      ...(parsed.data.visualDescription
        ? { visualDescription: parsed.data.visualDescription }
        : {}),
      ...(parsed.data.customQuery ? { customQuery: parsed.data.customQuery } : {}),
    });
    return NextResponse.json({ jobId }, { status: 202 });
  } catch (error) {
    return NextResponse.json({ error: 'enqueue failed', detail: String(error) }, { status: 502 });
  }
}
