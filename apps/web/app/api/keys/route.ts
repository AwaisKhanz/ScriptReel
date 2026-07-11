import * as db from '@scriptreel/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Provider key pool admin (doc 23). Secrets are never returned — only a masked tail.
const PROVIDERS = ['pexels', 'pixabay', 'openverse'] as const;

function mask(secret: string): string {
  return secret.length <= 4 ? '••••' : `••••${secret.slice(-4)}`;
}

export async function GET() {
  try {
    const rows = await db.listProviderKeys();
    const keys = rows.map((k) => ({
      id: k.id,
      provider: k.provider,
      label: k.label,
      active: k.active,
      masked: mask(k.secret),
      created_at: k.created_at,
    }));
    return NextResponse.json({ keys });
  } catch (error) {
    return NextResponse.json({ error: 'db unavailable', detail: String(error) }, { status: 502 });
  }
}

const AddSchema = z.object({
  provider: z.enum(PROVIDERS),
  secret: z.string().min(6).max(200),
  label: z.string().max(60).optional(),
});

export async function POST(req: Request) {
  const parsed = AddSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid body' },
      { status: 400 },
    );
  }
  try {
    const row = await db.insertProviderKey({
      provider: parsed.data.provider,
      secret: parsed.data.secret,
      ...(parsed.data.label ? { label: parsed.data.label } : {}),
    });
    return NextResponse.json(
      { id: row.id, provider: row.provider, label: row.label, masked: mask(row.secret) },
      { status: 201 },
    );
  } catch (error) {
    return NextResponse.json({ error: 'insert failed', detail: String(error) }, { status: 502 });
  }
}
