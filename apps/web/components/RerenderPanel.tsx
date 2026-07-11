'use client';

import {
  invalidatedStages,
  MUSIC_MOODS,
  type PipelineStage,
  QUALITIES,
  SUBTITLE_POSITIONS,
  SUBTITLE_PRESETS,
} from '@scriptreel/core';
import { useState } from 'react';
import { AspectToggle, Field, Pills, Slider } from './controls';
import { Button, Card, Spinner } from './ui';

type Aspect = '16:9' | '9:16' | '1:1';

export interface Editable {
  aspect: Aspect;
  quality: 'draft' | 'final';
  subtitlePreset: (typeof SUBTITLE_PRESETS)[number];
  subtitlePosition: (typeof SUBTITLE_POSITIONS)[number];
  musicMood: (typeof MUSIC_MOODS)[number];
  musicLevelDb: number;
}

const PRETTY: Record<string, string> = {
  draft: 'Draft 720p',
  final: 'Final 1080p',
  clean: 'Clean',
  pop: 'Pop',
  lowerthird: 'Lower third',
  documentary: 'Documentary',
  none: 'None',
  bottom: 'Bottom',
  middle: 'Middle',
  top: 'Top',
  auto: 'Auto',
  uplifting: 'Uplifting',
  calm: 'Calm',
  corporate: 'Corporate',
  emotional: 'Emotional',
  energetic: 'Energetic',
  tense: 'Tense',
};
const labeled = <T extends string>(opts: readonly T[]) =>
  opts.map((v) => ({ value: v, label: PRETTY[v] ?? v }));

// Rough per-stage wall-clock for the preview sentence (doc 16).
const STAGE_SECS: Record<PipelineStage, number> = {
  analyze: 20,
  search: 40,
  score: 30,
  tts: 30,
  align: 20,
  fetch: 90,
  compose: 50,
};
function estimate(stages: PipelineStage[]): string {
  const secs = stages.reduce((s, st) => s + STAGE_SECS[st], 0);
  return secs >= 90 ? `~${Math.round(secs / 60)} min` : `~${secs} s`;
}

export function RerenderPanel({
  projectId,
  current,
  onQueued,
}: {
  projectId: string;
  current: Editable;
  onQueued: () => void;
}) {
  const [s, setS] = useState<Editable>(current);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof Editable>(k: K, v: Editable[K]) =>
    setS((prev) => ({ ...prev, [k]: v }));

  const patch = Object.fromEntries(
    (Object.keys(s) as (keyof Editable)[]).filter((k) => s[k] !== current[k]).map((k) => [k, s[k]]),
  );
  const stages = invalidatedStages(patch, current);
  const dirty = stages.length > 0;

  async function rerender() {
    setBusy(true);
    const res = await fetch(`/api/projects/${projectId}/rerender`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }).catch(() => null);
    if (res?.ok) onQueued();
    else setBusy(false);
  }

  return (
    <Card accent className="space-y-5">
      <div>
        <h3 className="text-sm font-semibold">Re-render</h3>
        <p className="mt-0.5 text-sm text-fg-muted">
          Adjust the look — only the affected stages re-run.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <Field label="Aspect ratio">
          <AspectToggle value={s.aspect} onChange={(v) => set('aspect', v)} />
        </Field>
        <div className="space-y-5">
          <Field label="Quality">
            <Pills
              value={s.quality}
              options={labeled(QUALITIES)}
              onChange={(v) => set('quality', v)}
            />
          </Field>
          <Field label="Music mood">
            <Pills
              value={s.musicMood}
              options={labeled(MUSIC_MOODS)}
              onChange={(v) => set('musicMood', v)}
            />
          </Field>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <Field label="Subtitles">
          <Pills
            value={s.subtitlePreset}
            options={labeled(SUBTITLE_PRESETS)}
            onChange={(v) => set('subtitlePreset', v)}
          />
        </Field>
        {s.subtitlePreset !== 'none' && (
          <Field label="Position">
            <Pills
              value={s.subtitlePosition}
              options={labeled(SUBTITLE_POSITIONS)}
              onChange={(v) => set('subtitlePosition', v)}
            />
          </Field>
        )}
      </div>

      {s.musicMood !== 'none' && (
        <Field label="Music level">
          <Slider
            value={s.musicLevelDb}
            min={-24}
            max={-10}
            step={1}
            onChange={(v) => set('musicLevelDb', v)}
            suffix=" dB"
          />
        </Field>
      )}

      <div className="flex flex-col items-start justify-between gap-3 border-t border-border pt-4 sm:flex-row sm:items-center">
        <p className="text-sm text-fg-muted">
          {dirty ? (
            <>
              Will re-run: <span className="font-medium text-fg">{stages.join(' → ')}</span>{' '}
              <span className="text-fg-subtle">({estimate(stages)})</span>
              {stages.includes('fetch') && (
                <span className="text-fg-subtle"> — re-fetches visuals</span>
              )}
            </>
          ) : (
            'Change a setting to re-render.'
          )}
        </p>
        <Button variant="primary" disabled={!dirty || busy} onClick={rerender}>
          {busy ? <Spinner /> : 'Re-render'}
        </Button>
      </div>
    </Card>
  );
}
