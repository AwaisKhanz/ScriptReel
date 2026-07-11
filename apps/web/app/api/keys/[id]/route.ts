import * as db from '@scriptreel/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const ok = await db.deleteProviderKey(id);
    if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: 'delete failed', detail: String(error) }, { status: 502 });
  }
}

const PatchSchema = z.object({ active: z.boolean() });

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = PatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'expected {active}' }, { status: 400 });
  try {
    await db.setProviderKeyActive(id, parsed.data.active);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: 'update failed', detail: String(error) }, { status: 502 });
  }
}
