'use client';

import { STAGES } from '@scriptreel/core';
import type { StageRun } from '../hooks/useProject';

const DOT: Record<string, string> = {
  pending: 'bg-surface-2 text-fg-subtle',
  running: 'bg-progress text-[#0A0C10]',
  done: 'bg-success text-[#0A0C10]',
  skipped: 'bg-surface-2 text-fg-subtle',
  failed: 'bg-danger text-[#0A0C10]',
};

export function StageStepper({ runs }: { runs: StageRun[] }) {
  const byStage = new Map(runs.map((r) => [r.stage, r]));
  return (
    <ol className="space-y-1">
      {STAGES.map((stage) => {
        const run = byStage.get(stage) ?? { stage, status: 'pending', progress: 0 };
        return (
          <li key={stage} className="flex items-center gap-3 rounded-md px-2 py-2">
            <span
              className={`flex size-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${DOT[run.status] ?? DOT.pending}`}
            >
              {run.status === 'done'
                ? '✓'
                : run.status === 'skipped'
                  ? '↺'
                  : run.status === 'failed'
                    ? '!'
                    : ''}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span
                  className={`text-sm capitalize ${run.status === 'pending' ? 'text-fg-subtle' : 'text-fg'}`}
                >
                  {stage}
                  {run.status === 'skipped' && (
                    <span className="ml-2 text-xs text-fg-subtle">cached</span>
                  )}
                </span>
                {run.status === 'running' && (
                  <span className="font-mono text-xs text-progress">{run.progress}%</span>
                )}
              </div>
              {run.status === 'running' && (
                <>
                  <div className="mt-1 h-1 overflow-hidden rounded-full bg-surface-2">
                    <div
                      className="h-full rounded-full bg-progress transition-[width] duration-300"
                      style={{ width: `${run.progress}%` }}
                    />
                  </div>
                  {run.detail && (
                    <div className="mt-1 truncate text-xs text-fg-subtle">{run.detail}</div>
                  )}
                </>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
