import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from '@scriptreel/config';
import {
  type AlignedWord,
  buildAss,
  type SubtitleAspect,
  type SubtitlePreset,
} from '@scriptreel/core';

function subsDir(projectId: string): string {
  return join(paths.projectDir(projectId), 'subs');
}

// Durable artifact (doc 11): words.json, not ASS — ASS is regenerated per style/aspect.
export async function writeWordsJson(
  projectId: string,
  words: readonly AlignedWord[],
): Promise<string> {
  const dir = subsDir(projectId);
  await mkdir(dir, { recursive: true });
  const outPath = join(dir, 'words.json');
  await writeFile(outPath, JSON.stringify(words, null, 2), 'utf8');
  return outPath;
}

// render.ass is built at compose time from words.json + current preset + aspect.
export async function writeRenderAss(
  projectId: string,
  words: readonly AlignedWord[],
  preset: SubtitlePreset,
  aspect: SubtitleAspect,
  language: string,
): Promise<string> {
  const dir = subsDir(projectId);
  await mkdir(dir, { recursive: true });
  const outPath = join(dir, 'render.ass');
  await writeFile(outPath, buildAss({ words, preset, aspect, language }), 'utf8');
  return outPath;
}
