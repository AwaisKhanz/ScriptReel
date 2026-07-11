import {
  ASPECTS,
  MUSIC_MOODS,
  type ProjectSettings,
  QUALITIES,
  STAGES,
  SUBTITLE_POSITIONS,
  SUBTITLE_PRESETS,
} from '@scriptreel/core';
import * as db from '@scriptreel/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { enqueuePipeline } from '@/lib/queue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const RerenderSchema = z.object({
  subtitlePreset: z.enum(SUBTITLE_PRESETS).optional(),
  subtitlePosition: z.enum(SUBTITLE_POSITIONS).optional(),
  musicMood: z.enum(MUSIC_MOODS).optional(),
  musicTrackId: z.string().optional(),
  musicLevelDb: z.number().min(-24).max(-10).optional(),
  quality: z.enum(QUALITIES).optional(),
  aspect: z.enum(ASPECTS).optional(),
});

// Patch settings, then enqueue the narrowest mode (doc 15): aspect change → full
// (manifests skip what survives); anything else → composeOnly.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = await db.getProject(id);
  if (!project) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const parsed = RerenderSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid body' },
      { status: 400 },
    );
  }

  const patch = Object.fromEntries(
    Object.entries(parsed.data).filter(([, v]) => v !== undefined),
  ) as Partial<ProjectSettings>;
  const aspectChanged =
    patch.aspect !== undefined && patch.aspect !== (project.settings as { aspect?: string }).aspect;
  const invalidatedStages = aspectChanged ? ['search', 'score', 'fetch', 'compose'] : ['compose'];

  try {
    await db.updateProjectSettings(id, patch);
    await db.ensurePipelineRuns(id, STAGES);
    await db.clearCancel(id);
    await db.setProjectStatus(id, 'queued');
    await enqueuePipeline(id, aspectChanged ? 'full' : 'composeOnly');
    return NextResponse.json({ invalidatedStages }, { status: 202 });
  } catch (error) {
    return NextResponse.json({ error: 'rerender failed', detail: String(error) }, { status: 502 });
  }
}
