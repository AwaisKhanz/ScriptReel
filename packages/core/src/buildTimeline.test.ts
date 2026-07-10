import { describe, expect, it } from 'vitest';
import { type BuildBeatInput, type BuildTimelineInput, buildTimeline } from './buildTimeline';
import { FRAME_SEC } from './constants';
import { assertTimelineInvariants } from './timeline';

// Seeded PRNG (mulberry32) — deterministic, no dependency.
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KINDS = ['video', 'image', 'generated', 'textcard'] as const;
const SHOTS = ['wide', 'medium', 'close'] as const;
const EMOTIONS = ['calm', 'tense', 'uplifting'] as const;

function randomInput(rnd: () => number): BuildTimelineInput {
  const n = 1 + Math.floor(rnd() * 12); // 1..12 beats
  const pauseSec = Math.round(rnd() * 600) / 1000; // 0..0.6 s
  const beats: BuildBeatInput[] = [];
  let sumNarration = 0;
  for (let i = 0; i < n; i += 1) {
    const narrationDurationSec = 1 + rnd() * 9; // 1..10 s
    sumNarration += narrationDurationSec;
    const kind = KINDS[Math.floor(rnd() * KINDS.length)] ?? 'image';
    const media: BuildBeatInput['media'] =
      kind === 'video'
        ? {
            kind: 'video',
            path: `/clips/${i}.mp4`,
            sourceDurationSec: narrationDurationSec * (0.5 + rnd() * 2),
          }
        : { kind, path: `/clips/${i}.mp4` };
    beats.push({
      idx: i,
      text: `beat ${i}`,
      narrationDurationSec,
      shotType: SHOTS[i % SHOTS.length],
      emotion: EMOTIONS[i % EMOTIONS.length],
      media,
    });
  }
  // Keep narration consistent with the builder's model: Σ narration + (n-1) pauses.
  const durationSec = sumNarration + (n - 1) * pauseSec;
  const styles = ['crossfade', 'cut', 'smart'] as const;
  return {
    projectId: 'p',
    createdAt: '2026-07-10T00:00:00Z',
    render: { aspect: '16:9', width: 1920, height: 1080, preset: 'final' },
    narration: { audioPath: '/vo.wav', durationSec },
    beats,
    pauseSec,
    transitions: { style: styles[Math.floor(rnd() * styles.length)] ?? 'smart', crossfadeSec: 0.4 },
    music: null,
    subtitles: null,
    credits: '',
  };
}

describe('buildTimeline', () => {
  it('satisfies doc-12 invariants over 500 random inputs', () => {
    const rnd = mulberry32(0x5c817ee1);
    for (let iteration = 0; iteration < 500; iteration += 1) {
      const timeline = buildTimeline(randomInput(rnd));
      expect(() => assertTimelineInvariants(timeline)).not.toThrow();

      expect(timeline.beats[0]?.startSec).toBe(0);
      const sum = timeline.beats.reduce((acc, b) => acc + b.durationSec, 0);
      expect(Math.abs(sum - timeline.narration.durationSec)).toBeLessThanOrEqual(FRAME_SEC + 1e-9);

      for (const beat of timeline.beats) {
        if (beat.media.kind !== 'video') {
          expect(beat.media.kenburns).toBeDefined();
        }
      }
      if (timeline.transitions.perBoundary) {
        expect(timeline.transitions.perBoundary.length).toBe(timeline.beats.length - 1);
      }
    }
  });
});
