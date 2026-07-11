'use client';

import { STAGES } from '@scriptreel/core';
import type { StageRun } from '../hooks/useProject';
import { ProgressBar } from './ui';

const LABELS: Record<string, string> = {
  analyze: 'Analyze script',
  search: 'Search stock',
  score: 'Score & match',
  tts: 'Narrate',
  align: 'Align subtitles',
  fetch: 'Fetch assets',
  compose: 'Compose video',
};

export function StageStepper({ runs }: { runs: StageRun[] }) {
  const byStage = new Map(runs.map((r) => [r.stage, r]));
  return (
    <ol className="relative space-y-0.5">
      {STAGES.map((stage, i) => {
        const run = byStage.get(stage) ?? { stage, status: 'pending', progress: 0 };
        const last = i === STAGES.length - 1;
        return (
          <li key={stage} className="flex gap-3.5">
            {/* node + connector */}
            <div className="flex flex-col items-center">
              <Node status={run.status} />
              {!last && (
                <span
                  className={`w-px flex-1 ${run.status === 'done' ? 'bg-success/40' : 'bg-border'}`}
                />
              )}
            </div>
            {/* body */}
            <div className={`min-w-0 flex-1 ${last ? 'pb-0' : 'pb-4'}`}>
              <div className="flex items-center justify-between gap-2">
                <span
                  className={`text-sm font-medium ${
                    run.status === 'pending' ? 'text-fg-subtle' : 'text-fg'
                  }`}
                >
                  {LABELS[stage] ?? stage}
                </span>
                {run.status === 'skipped' && (
                  <span className="rounded-md bg-surface-2 px-2 py-0.5 text-xs text-fg-subtle">
                    cached
                  </span>
                )}
                {run.status === 'running' && (
                  <span className="font-mono text-xs text-progress">{run.progress}%</span>
                )}
                {run.status === 'done' && <span className="text-xs text-success">done</span>}
              </div>
              {run.status === 'running' && (
                <>
                  <ProgressBar value={run.progress} tone="progress" className="mt-2 h-1" />
                  {run.detail && (
                    <div className="mt-1.5 truncate text-xs text-fg-subtle">{run.detail}</div>
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

function Node({ status }: { status: string }) {
  if (status === 'done') {
    return (
      <span className="z-10 flex size-6 items-center justify-center rounded-full bg-success text-white">
        <svg
          viewBox="0 0 24 24"
          className="size-3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          aria-hidden
        >
          <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    );
  }
  if (status === 'running') {
    return (
      <span className="z-10 flex size-6 animate-[var(--animate-pulse-ring)] items-center justify-center rounded-full bg-progress text-white">
        <span className="size-2 animate-pulse rounded-full bg-white" />
      </span>
    );
  }
  if (status === 'failed') {
    return (
      <span className="z-10 flex size-6 items-center justify-center rounded-full bg-danger text-white">
        <svg
          viewBox="0 0 24 24"
          className="size-3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          aria-hidden
        >
          <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
        </svg>
      </span>
    );
  }
  if (status === 'skipped') {
    return (
      <span className="z-10 flex size-6 items-center justify-center rounded-full border border-border-strong bg-surface-2 text-fg-subtle">
        <svg
          viewBox="0 0 24 24"
          className="size-3"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          aria-hidden
        >
          <path
            d="M4 12a8 8 0 1 1 2.3 5.6M4 12V7m0 5h5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    );
  }
  return (
    <span className="z-10 flex size-6 items-center justify-center rounded-full border border-border bg-surface">
      <span className="size-1.5 rounded-full bg-fg-subtle/50" />
    </span>
  );
}
