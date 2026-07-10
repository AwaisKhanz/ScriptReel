import type { PipelineStage, ProjectSettings } from '@scriptreel/core';
import type { Logger } from 'pino';

// Everything a stage needs to run (doc 06 stage contract).
export interface ProjectCtx {
  projectId: string;
  settings: ProjectSettings;
  fake: boolean;
  log: Logger;
  signal: AbortSignal; // aborted on cancel; stages thread it into every child
}

// report() at least every ~2 s of work; the worker throttles DB writes to 500 ms.
export type Reporter = ((pct: number, detail?: string) => void) & {
  flush(pct?: number): Promise<void>;
};

export interface Stage {
  name: PipelineStage;
  inputsHash(ctx: ProjectCtx): Promise<string>;
  run(ctx: ProjectCtx, report: Reporter): Promise<void>;
}
