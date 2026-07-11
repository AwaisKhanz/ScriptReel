import type { ProjectSettings } from '@scriptreel/core';
import * as db from '@scriptreel/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return NextResponse.json({ projects: await db.listProjects() });
  } catch (error) {
    return NextResponse.json({ error: 'db unavailable', detail: String(error) }, { status: 502 });
  }
}

const CreateSchema = z.object({
  script: z
    .string()
    .min(50, 'script must be at least 50 characters')
    .max(6000, 'script must be ≤ 6000 characters'),
  title: z.string().max(200).optional(),
  // Settings are re-validated by db.createProject (parseSettings over defaults).
  settings: z.record(z.string(), z.unknown()).optional(),
});

export async function POST(req: Request) {
  const parsed = CreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid body' },
      { status: 400 },
    );
  }
  const { script, title, settings } = parsed.data;
  try {
    const project = await db.createProject({
      script,
      title: title?.trim() || script.split(/\s+/).slice(0, 6).join(' '),
      ...(settings ? { settings: settings as Partial<ProjectSettings> } : {}),
    });
    return NextResponse.json({ project }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: 'create failed', detail: String(error) }, { status: 502 });
  }
}
