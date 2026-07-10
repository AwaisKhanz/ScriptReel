import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from '@scriptreel/config';
import { type PipelineStage, STAGES } from '@scriptreel/core';
import { z } from 'zod';

// The on-disk resume record for a stage (doc 06). Zod-validated on read
// (doc 18: parse at every boundary, including JSON.parse of a manifest).
const StageManifestSchema = z.object({
  stage: z.enum(STAGES),
  inputsHash: z.string(),
  completedAt: z.string(),
  artifacts: z.array(z.string()),
  warnings: z.array(z.string()),
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type StageManifest = z.infer<typeof StageManifestSchema>;

export function stageDir(projectId: string, stage: PipelineStage): string {
  return join(paths.projectDir(projectId), 'stages', stage);
}

export async function readManifest(
  projectId: string,
  stage: PipelineStage,
): Promise<StageManifest | null> {
  try {
    const raw = await readFile(join(stageDir(projectId, stage), 'manifest.json'), 'utf8');
    const parsed = StageManifestSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null; // missing or corrupt → treat as not-done, clean re-run
  }
}

// A stage artifact (written before the manifest). Non-atomic — the manifest is the
// atomic "done" marker written last.
export async function writeStageJson(
  projectId: string,
  stage: PipelineStage,
  filename: string,
  data: unknown,
): Promise<void> {
  const dir = stageDir(projectId, stage);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, filename), JSON.stringify(data, null, 2), 'utf8');
}

// Write artifacts first, then the manifest atomically: tmp → fsync → rename (doc 06).
export async function writeManifest(
  projectId: string,
  stage: PipelineStage,
  manifest: StageManifest,
): Promise<void> {
  const dir = stageDir(projectId, stage);
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'manifest.json');
  const tmp = `${file}.tmp`;
  const handle = await open(tmp, 'w');
  try {
    await handle.writeFile(JSON.stringify(manifest, null, 2));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, file);
}
