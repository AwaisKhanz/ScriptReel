import { credentialFields, PROVIDER_CREDENTIALS, type ProviderId } from '@scriptreel/core';
import * as db from '@scriptreel/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Provider key pool admin (doc 23). Each provider declares its own credential
// fields (PROVIDER_CREDENTIALS) — one API key, or an OAuth id + secret pair, etc.
// Secret fields are never returned; the UI only ever sees a masked tail.
const ADDABLE = (Object.keys(PROVIDER_CREDENTIALS) as ProviderId[]).filter(
  (p) => credentialFields(p).length > 0,
);

function maskSecret(value: string): string {
  return value.length <= 4 ? '••••' : `••••${value.slice(-4)}`;
}

// A per-field view: secret fields masked, public fields (e.g. a client id) shown.
function fieldViews(provider: string, creds: Record<string, string>) {
  return credentialFields(provider as ProviderId).map((f) => {
    const value = creds[f.name] ?? '';
    return {
      name: f.name,
      label: f.label,
      secret: f.secret,
      value: f.secret ? maskSecret(value) : value,
    };
  });
}

export async function GET() {
  try {
    const rows = await db.listProviderKeys();
    const keys = rows.map((k) => ({
      id: k.id,
      provider: k.provider,
      label: k.label,
      active: k.active,
      fields: fieldViews(k.provider, k.creds),
      created_at: k.created_at,
    }));
    return NextResponse.json({ keys });
  } catch (error) {
    return NextResponse.json({ error: 'db unavailable', detail: String(error) }, { status: 502 });
  }
}

const AddSchema = z.object({
  provider: z.string(),
  credentials: z.record(z.string(), z.string()),
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
  const { provider, credentials, label } = parsed.data;
  if (!ADDABLE.includes(provider as ProviderId)) {
    return NextResponse.json({ error: `unknown provider: ${provider}` }, { status: 400 });
  }
  // Every declared field must be present and non-trivial — a partial OAuth pair
  // is worse than none (it would fail silently at token-exchange time).
  const fields = credentialFields(provider as ProviderId);
  const clean: Record<string, string> = {};
  for (const f of fields) {
    const v = credentials[f.name]?.trim();
    if (!v || v.length < 4) {
      return NextResponse.json({ error: `${f.label} is required` }, { status: 400 });
    }
    clean[f.name] = v;
  }
  try {
    const row = await db.insertProviderKey({
      provider,
      credentials: clean,
      ...(label ? { label } : {}),
    });
    return NextResponse.json(
      {
        id: row.id,
        provider: row.provider,
        label: row.label,
        active: row.active,
        fields: fieldViews(row.provider, row.creds),
      },
      { status: 201 },
    );
  } catch (error) {
    return NextResponse.json({ error: 'insert failed', detail: String(error) }, { status: 502 });
  }
}
