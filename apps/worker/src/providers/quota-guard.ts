import { setTimeout as delay } from 'node:timers/promises';
import {
  OPENVERSE_DAY_BUDGET,
  PEXELS_HOUR_BUDGET,
  PEXELS_MONTH_BUDGET,
  PIXABAY_MINUTE_BUDGET,
  PipelineError,
  type ProviderId,
  truncateWindow,
} from '@scriptreel/core';
import * as db from '@scriptreel/db';
import type { Logger } from 'pino';

// Durable token accounting in provider_usage (doc 08 §QuotaGuard). Reserve one
// request before any real HTTP call; Pexels hour/month → E_QUOTA_PEXELS, Pixabay
// minute → wait for rollover (≤60 s) then retry.
export class QuotaGuard {
  constructor(private readonly log: Logger) {}

  async reserve(provider: ProviderId): Promise<void> {
    const now = new Date();
    if (provider === 'openverse') {
      const day = await db.reserveQuota(
        'openverse:day',
        truncateWindow(now, 'day'),
        OPENVERSE_DAY_BUDGET,
      );
      if (day === null) {
        throw new PipelineError('E_QUOTA_OPENVERSE', 'search', 'Openverse daily budget reached');
      }
      return;
    }
    if (provider === 'pexels') {
      const hour = await db.reserveQuota(
        'pexels:hour',
        truncateWindow(now, 'hour'),
        PEXELS_HOUR_BUDGET,
      );
      if (hour === null) {
        throw new PipelineError('E_QUOTA_PEXELS', 'search', 'Pexels hourly budget reached');
      }
      const month = await db.reserveQuota(
        'pexels:month',
        truncateWindow(now, 'month'),
        PEXELS_MONTH_BUDGET,
      );
      if (month === null) {
        throw new PipelineError('E_QUOTA_PEXELS', 'search', 'Pexels monthly budget reached');
      }
      return;
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const minute = await db.reserveQuota(
        'pixabay:minute',
        truncateWindow(new Date(), 'minute'),
        PIXABAY_MINUTE_BUDGET,
      );
      if (minute !== null) return;
      const waitMs = 60_000 - (Date.now() % 60_000) + 500;
      this.log.warn({ waitMs }, 'pixabay minute budget reached — waiting for rollover');
      await delay(waitMs);
    }
    throw new PipelineError(
      'E_QUOTA_PIXABAY',
      'search',
      'Pixabay minute budget exhausted after wait',
    );
  }
}
