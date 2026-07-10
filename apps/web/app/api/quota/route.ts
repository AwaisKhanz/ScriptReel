import { QUOTA_BUDGETS, truncateWindow } from '@scriptreel/core';
import * as db from '@scriptreel/db';
import { NextResponse } from 'next/server';

// Live quota meters (doc 08 §QuotaGuard). Reads the same durable buckets the worker
// reserves against, so the numbers here match what QuotaGuard enforces per window.
export const dynamic = 'force-dynamic';

export async function GET() {
  const now = new Date();
  try {
    const meters = await Promise.all(
      QUOTA_BUDGETS.map(async (b) => {
        const windowStart = truncateWindow(now, b.unit);
        const used = await db.getProviderUsage(b.key, windowStart);
        return {
          key: b.key,
          unit: b.unit,
          used,
          budget: b.budget,
          remaining: Math.max(0, b.budget - used),
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
