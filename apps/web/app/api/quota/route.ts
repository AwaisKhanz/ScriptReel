import { type ProviderId, QUOTA_BUDGETS, truncateWindow } from '@scriptreel/core';
import * as db from '@scriptreel/db';
import { NextResponse } from 'next/server';

// Live quota meters (doc 08 + doc 23 key pool). Combined across every pooled key:
// budget = per-key budget × active keys, used = sum across keys. Matches what the
// worker's QuotaGuard enforces per key.
export const dynamic = 'force-dynamic';

const PROVIDERS: ProviderId[] = ['pexels', 'pixabay', 'openverse', 'nasa', 'wikimedia'];

export async function GET() {
  const now = new Date();
  try {
    const counts: Record<string, number> = {};
    for (const p of PROVIDERS) counts[p] = Math.max(1, (await db.activeKeysFor(p)).length);

    const meters = await Promise.all(
      QUOTA_BUDGETS.map(async (b) => {
        const windowStart = truncateWindow(now, b.unit);
        const keys = counts[b.key.split(':')[0] ?? ''] ?? 1;
        const used = await db.getCombinedUsage(b.key, windowStart);
        const budget = b.budget * keys;
        return {
          key: b.key,
          unit: b.unit,
          used,
          budget,
          keys,
          remaining: Math.max(0, budget - used),
          windowStart: windowStart.toISOString(),
        };
      }),
    );
    return NextResponse.json({ meters });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: 'quota unavailable', detail: String(error) },
      { status: 502 },
    );
  }
}
