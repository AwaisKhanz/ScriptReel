import { describe, expect, it } from 'vitest';
import { type BuildTimelineInput, buildTimeline } from '../buildTimeline';
import { clipPlan } from './plan';

function timeline(style: 'crossfade' | 'cut' | 'smart', shots: string[] = []) {
  const n = 3;
  const input: BuildTimelineInput = {
    projectId: 'p',
    createdAt: '2026-07-11T00:00:00.000Z',
    render: { aspect: '16:9', width: 1920, height: 1080, preset: 'final' },
    narration: { audioPath: 'vo.wav', durationSec: 6 },
    beats: Array.from({ length: n }, (_, i) => ({
      idx: i,
      text: `b${i}`,
      narrationDurationSec: 2,
      shotType: shots[i] ?? `shot${i}`,
      emotion: 'neutral',
      media: { kind: 'video' as const, path: `/v${i}.mp4`, sourceDurationSec: 20 },
    })),
    pauseSec: 0,
    transitions: { style, crossfadeSec: 0.4 },
    music: null,
    subtitles: null,
    credits: '',
  };
  return buildTimeline(input);
}

describe('clipPlan', () => {
  it('pads each crossfade side by a frame-aligned half-fade (0.2s), none on the ends', () => {
    const plan = clipPlan(timeline('crossfade'));
    expect(plan.map((p) => Number(p.headPadSec.toFixed(3)))).toEqual([0, 0.2, 0.2]);
    expect(plan.map((p) => Number(p.tailPadSec.toFixed(3)))).toEqual([0.2, 0.2, 0]);
    // L_i = d_i + head + tail; middle beat gets both sides.
    expect(plan[1] && Number(plan[1].lengthSec.toFixed(3))).toBe(2.4);
    expect(plan[0] && Number(plan[0].lengthSec.toFixed(3))).toBe(2.2);
  });

  it('adds no padding when every boundary is a hard cut', () => {
    const plan = clipPlan(timeline('cut'));
    expect(plan.every((p) => p.headPadSec === 0 && p.tailPadSec === 0)).toBe(true);
    expect(plan.every((p) => p.lengthSec === p.durationSec)).toBe(true);
  });

  it('smart mix pads only the crossfaded boundaries', () => {
    // beats 0,1 share shot+emotion → cut between them; beat 2 differs → crossfade at boundary 1.
    const plan = clipPlan(timeline('smart', ['A', 'A', 'B']));
    expect(plan[0]?.tailPadSec).toBe(0); // boundary 0 is a cut
    expect(plan[1]?.tailPadSec).toBeCloseTo(0.2, 3); // boundary 1 crossfades
    expect(plan[2]?.headPadSec).toBeCloseTo(0.2, 3);
  });
});
