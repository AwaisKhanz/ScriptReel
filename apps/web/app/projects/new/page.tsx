'use client';

import {
  MEDIA_PREFERENCES,
  MUSIC_MOODS,
  PACINGS,
  QUALITIES,
  SUBTITLE_POSITIONS,
  SUBTITLE_PRESETS,
  TRANSITION_STYLES,
} from '@scriptreel/core';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useMemo, useRef, useState } from 'react';
import { AspectToggle, Field, Pills, Slider } from '../../../components/controls';
import { SubtitlePreviewCanvas } from '../../../components/SubtitlePreviewCanvas';
import { Badge, Button, Card, Spinner } from '../../../components/ui';
import { apiError } from '../../../lib/api';
import { estimateBeats, estimateNarrationSec, fmtDuration } from '../../../lib/format';

interface Voice {
  id: string;
  displayName: string;
  gender: 'male' | 'female';
  language: string;
}
interface Track {
  id: string;
  title: string;
  moods: string[];
}

interface WizSettings {
  voice: string;
  speed: number;
  pauseMs: number;
  aspect: '16:9' | '9:16' | '1:1';
  quality: 'draft' | 'final';
  pacing: 'fast' | 'normal' | 'slow';
  mediaPreference: 'videos' | 'mixed' | 'photos';
  transitionStyle: 'crossfade' | 'cut' | 'smart';
  subtitlePreset: 'clean' | 'pop' | 'lowerthird' | 'documentary' | 'none';
  subtitlePosition: 'bottom' | 'middle' | 'top';
  musicMood: (typeof MUSIC_MOODS)[number];
  musicTrackId: string;
  musicLevelDb: number;
  reviewBeforeRender: boolean;
}

const DEFAULTS: WizSettings = {
  voice: 'af_heart',
  speed: 1.0,
  pauseMs: 150,
  aspect: '16:9',
  quality: 'final',
  pacing: 'normal',
  mediaPreference: 'mixed',
  transitionStyle: 'smart',
  subtitlePreset: 'clean',
  subtitlePosition: 'bottom',
  musicMood: 'auto',
  musicTrackId: '',
  musicLevelDb: -16,
  reviewBeforeRender: true,
};

// Friendly display labels — the value sent to the backend is always the enum.
const PRETTY: Record<string, string> = {
  draft: 'Draft 720p',
  final: 'Final 1080p',
  fast: 'Fast',
  normal: 'Normal',
  slow: 'Slow',
  videos: 'Videos only',
  mixed: 'Mixed',
  photos: 'Photos allowed',
  crossfade: 'Crossfade',
  cut: 'Hard cut',
  smart: 'Smart mix',
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

const STEPS = [
  { n: 1, title: 'Script', sub: 'Paste + language' },
  { n: 2, title: 'Voice', sub: 'Narration' },
  { n: 3, title: 'Look & sound', sub: 'Format, subs, music' },
];

export default function WizardPage() {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [script, setScript] = useState('');
  const [title, setTitle] = useState('');
  const [voiceLang, setVoiceLang] = useState('en-US');
  const [s, setS] = useState(DEFAULTS);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);

  const set = <K extends keyof typeof DEFAULTS>(k: K, v: (typeof DEFAULTS)[K]) =>
    setS((prev) => ({ ...prev, [k]: v }));

  const voices = useQuery<{ voices: Voice[] }>({
    queryKey: ['voices'],
    queryFn: () => fetch('/api/voices').then((r) => r.json()),
  });
  const music = useQuery<{ tracks: Track[] }>({
    queryKey: ['music'],
    queryFn: () => fetch('/api/music').then((r) => r.json()),
  });

  const narration = useMemo(() => estimateNarrationSec(script, s.speed), [script, s.speed]);
  const beats = useMemo(() => estimateBeats(script), [script]);
  const words = script.trim().split(/\s+/).filter(Boolean).length;
  const scriptValid = script.length >= 50 && script.length <= 50000;

  const langVoices = (voices.data?.voices ?? []).filter((v) => v.language === voiceLang);
  const voiceName = voices.data?.voices.find((v) => v.id === s.voice)?.displayName ?? s.voice;

  function goto(n: number) {
    if (n === 1 || scriptValid) setStep(n);
  }

  function play(url: string) {
    if (!audio.current) audio.current = new Audio();
    audio.current.pause();
    audio.current.src = url;
    void audio.current.play().catch(() => {});
  }

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const create = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          script,
          title: title || undefined,
          settings: { ...s, musicTrackId: s.musicTrackId || undefined },
        }),
      });
      if (!create.ok) throw await apiError(create, 'create failed');
      const body = await create.json();
      const id = body.project.id as string;
      const gen = await fetch(`/api/projects/${id}/generate`, { method: 'POST' });
      if (!gen.ok) throw await apiError(gen, 'generate failed');
      router.push(`/projects/${id}`);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      setSubmitting(false);
    }
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_300px]">
      <div className="space-y-6">
        <div className="animate-[var(--animate-fade-up)]">
          <h1 className="text-2xl font-semibold tracking-tight">Create a new video</h1>
          <p className="mt-1 text-sm text-fg-muted">
            Every default already makes a good video. Change things only for intent.
          </p>
        </div>

        {/* stepper cards */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {STEPS.map((st) => {
            const state = step === st.n ? 'active' : step > st.n ? 'done' : 'todo';
            return (
              <button
                key={st.n}
                type="button"
                onClick={() => goto(st.n)}
                className={`flex items-center gap-3 rounded-xl border p-3.5 text-left transition-all duration-[var(--dur-fast)] ${
                  state === 'active'
                    ? 'border-accent/40 bg-accent-quiet shadow-[var(--shadow-xs)]'
                    : 'border-border bg-surface hover:border-border-strong'
                }`}
              >
                <span
                  className={`flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-bold transition-colors ${
                    state === 'done'
                      ? 'bg-success/15 text-success'
                      : state === 'active'
                        ? 'brand-gradient text-white'
                        : 'bg-surface-2 text-fg-subtle'
                  }`}
                >
                  {state === 'done' ? '✓' : st.n}
                </span>
                <span className="min-w-0">
                  <span
                    className={`block text-sm font-semibold ${state === 'todo' ? 'text-fg-muted' : 'text-fg'}`}
                  >
                    {st.title}
                  </span>
                  <span className="block truncate text-xs text-fg-subtle">{st.sub}</span>
                </span>
              </button>
            );
          })}
        </div>

        {/* step 1 — script */}
        {step === 1 && (
          <Card className="space-y-5 animate-[var(--animate-fade-in)]">
            <Field label="Title" hint="optional — defaults to the first few words">
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="How Your Immune System Remembers"
                className="w-full rounded-lg border border-border bg-bg px-3.5 py-2.5 text-sm outline-none transition-colors focus:border-accent/50 focus:ring-2 focus:ring-accent/25"
              />
            </Field>
            <Field label="Script" hint="50–50,000 characters, plain text">
              <textarea
                value={script}
                onChange={(e) => setScript(e.target.value)}
                rows={12}
                placeholder="Paste your script…"
                className="w-full resize-y rounded-lg border border-border bg-bg p-3.5 font-mono text-sm leading-relaxed outline-none transition-colors focus:border-accent/50 focus:ring-2 focus:ring-accent/25"
              />
            </Field>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-subtle">
              <span className={script.length > 50000 ? 'text-danger' : ''}>
                {script.length.toLocaleString()} / 50,000 chars
              </span>
              <span>·</span>
              <span>{words} words</span>
              <span>·</span>
              <span>≈ {fmtDuration(narration)} narration</span>
              <span>·</span>
              <span>≈ {beats} beats</span>
            </div>
            <Field label="Language">
              <Pills
                value={voiceLang}
                options={['en-US', 'en-GB', 'es', 'fr', 'hi', 'it', 'pt-BR', 'ja', 'zh']}
                onChange={setVoiceLang}
              />
            </Field>
          </Card>
        )}

        {/* step 2 — voice */}
        {step === 2 && (
          <Card className="space-y-5 animate-[var(--animate-fade-in)]">
            <Field label="Voice language">
              <Pills
                value={voiceLang}
                options={['en-US', 'en-GB', 'es', 'fr', 'hi', 'it', 'pt-BR', 'ja', 'zh']}
                onChange={setVoiceLang}
              />
            </Field>
            {voices.isLoading ? (
              <div className="flex justify-center py-8">
                <Spinner className="text-accent" />
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                {langVoices.map((v) => {
                  const active = s.voice === v.id;
                  return (
                    <div
                      key={v.id}
                      className={`flex items-center gap-3 rounded-xl border p-3 transition-all duration-[var(--dur-fast)] ${
                        active
                          ? 'border-accent/40 bg-accent-quiet'
                          : 'border-border bg-surface-2 hover:border-border-strong'
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => play(`/api/voices/${v.id}/sample`)}
                        className="flex size-9 shrink-0 items-center justify-center rounded-full bg-surface text-accent shadow-[var(--shadow-xs)] transition-transform hover:scale-105 active:scale-95"
                        aria-label={`Preview ${v.displayName}`}
                      >
                        <svg
                          viewBox="0 0 24 24"
                          className="size-3.5"
                          fill="currentColor"
                          aria-hidden
                        >
                          <path d="M8 5.5v13l11-6.5z" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        className="min-w-0 flex-1 text-left"
                        onClick={() => set('voice', v.id)}
                      >
                        <div className="truncate text-sm font-semibold">{v.displayName}</div>
                        <div className="font-mono text-xs text-fg-subtle">{v.id}</div>
                      </button>
                      <span
                        className={`flex size-6 items-center justify-center rounded-md text-xs font-bold ${
                          v.gender === 'female' ? 'text-danger' : 'text-accent'
                        }`}
                      >
                        {v.gender === 'female' ? 'F' : 'M'}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
              <Field label="Speed" hint={`≈ ${fmtDuration(narration)} at this speed`}>
                <Slider
                  value={s.speed}
                  min={0.8}
                  max={1.3}
                  step={0.05}
                  onChange={(v) => set('speed', v)}
                  suffix="×"
                />
              </Field>
              <Field label="Pause between beats" hint="silence at each boundary">
                <Slider
                  value={s.pauseMs}
                  min={0}
                  max={600}
                  step={10}
                  onChange={(v) => set('pauseMs', v)}
                  suffix="ms"
                />
              </Field>
            </div>
          </Card>
        )}

        {/* step 3 — look & sound */}
        {step === 3 && (
          <Card className="space-y-6 animate-[var(--animate-fade-in)]">
            <Field label="Aspect ratio">
              <AspectToggle value={s.aspect} onChange={(v) => set('aspect', v)} />
            </Field>
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
              <Field label="Quality">
                <Pills
                  value={s.quality}
                  options={labeled(QUALITIES)}
                  onChange={(v) => set('quality', v)}
                />
              </Field>
              <Field label="Pacing">
                <Pills
                  value={s.pacing}
                  options={labeled(PACINGS)}
                  onChange={(v) => set('pacing', v)}
                />
              </Field>
              <Field label="Media">
                <Pills
                  value={s.mediaPreference}
                  options={labeled(MEDIA_PREFERENCES)}
                  onChange={(v) => set('mediaPreference', v)}
                />
              </Field>
              <Field label="Transitions">
                <Pills
                  value={s.transitionStyle}
                  options={labeled(TRANSITION_STYLES)}
                  onChange={(v) => set('transitionStyle', v)}
                />
              </Field>
            </div>

            <Field label="Subtitles" hint="live preview matches the burned output">
              <Pills
                value={s.subtitlePreset}
                options={labeled(SUBTITLE_PRESETS)}
                onChange={(v) => set('subtitlePreset', v)}
              />
            </Field>
            <div className="rounded-xl border border-border bg-bg p-4">
              <div className="mb-3 flex items-center justify-between">
                <span className="font-mono text-xs text-fg-subtle">live preview · {s.aspect}</span>
                {s.subtitlePreset !== 'none' && (
                  <span className="text-xs text-fg-subtle">{PRETTY[s.subtitlePreset]}</span>
                )}
              </div>
              <SubtitlePreviewCanvas
                preset={s.subtitlePreset}
                aspect={s.aspect}
                position={s.subtitlePosition}
              />
              {s.subtitlePreset !== 'none' && (
                <div className="mt-4">
                  <Pills
                    value={s.subtitlePosition}
                    options={labeled(SUBTITLE_POSITIONS)}
                    onChange={(v) => set('subtitlePosition', v)}
                  />
                </div>
              )}
            </div>

            <Field label="Music mood">
              <Pills
                value={s.musicMood}
                options={labeled(MUSIC_MOODS)}
                onChange={(v) => {
                  set('musicMood', v);
                  set('musicTrackId', '');
                }}
              />
            </Field>
            {music.data && s.musicMood !== 'none' && (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {music.data.tracks
                  .filter((t) => s.musicMood === 'auto' || t.moods.includes(s.musicMood))
                  .slice(0, 8)
                  .map((t) => {
                    const active = s.musicTrackId === t.id;
                    return (
                      <div
                        key={t.id}
                        className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 transition-all duration-[var(--dur-fast)] ${
                          active
                            ? 'border-accent/40 bg-accent-quiet'
                            : 'border-border bg-surface-2 hover:border-border-strong'
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => play(`/api/files/assets/music/${t.id}.mp3`)}
                          className="flex size-7 shrink-0 items-center justify-center rounded-full bg-surface text-accent shadow-[var(--shadow-xs)]"
                          aria-label={`Preview ${t.title}`}
                        >
                          <svg
                            viewBox="0 0 24 24"
                            className="size-3"
                            fill="currentColor"
                            aria-hidden
                          >
                            <path d="M8 5.5v13l11-6.5z" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          className="min-w-0 flex-1 truncate text-left text-sm"
                          onClick={() => set('musicTrackId', t.id)}
                        >
                          {t.title}
                        </button>
                      </div>
                    );
                  })}
              </div>
            )}
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

            <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-border bg-surface-2 p-3.5">
              <input
                type="checkbox"
                checked={s.reviewBeforeRender}
                onChange={(e) => set('reviewBeforeRender', e.target.checked)}
                className="size-4 accent-[var(--color-accent)]"
              />
              <span className="text-sm">
                <span className="font-medium">Review before render</span>
                <span className="block text-xs text-fg-subtle">
                  Pause at the storyboard to approve assets before composing.
                </span>
              </span>
            </label>
          </Card>
        )}

        {error && (
          <p className="rounded-lg border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-sm text-danger">
            {error}
          </p>
        )}

        <div className="flex justify-between">
          <Button
            variant="ghost"
            onClick={() => setStep((n) => Math.max(1, n - 1))}
            disabled={step === 1}
          >
            Back
          </Button>
          {step < 3 ? (
            <Button
              variant="primary"
              onClick={() => goto(step + 1)}
              disabled={step === 1 && !scriptValid}
            >
              Next
            </Button>
          ) : (
            <Button variant="primary" onClick={submit} disabled={submitting || !scriptValid}>
              {submitting ? <Spinner /> : 'Generate video'}
            </Button>
          )}
        </div>
      </div>

      {/* summary rail */}
      <Card accent className="h-max space-y-4 lg:sticky lg:top-24">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">Summary</h3>
        <dl className="space-y-2.5">
          <Row label="Estimated duration" value={`≈ ${fmtDuration(narration)}`} />
          <Row label="Beats" value={`≈ ${beats}`} />
          <Row label="Voice" value={voiceName} />
          <Row label="Aspect · quality" value={`${s.aspect} · ${PRETTY[s.quality]}`} />
          <Row label="Est. Pexels requests" value={`${beats}`} />
        </dl>
        <div className="flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-2 text-xs text-fg-muted">
          <svg
            viewBox="0 0 24 24"
            className="size-3.5 text-progress"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden
          >
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          ≈ {s.quality === 'draft' ? '2' : '4'} min to render on this machine
        </div>
        <Badge tone={s.reviewBeforeRender ? 'accent' : 'neutral'}>
          {s.reviewBeforeRender ? 'Review before render' : 'Straight to render'}
        </Badge>
      </Card>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <dt className="text-fg-subtle">{label}</dt>
      <dd className="truncate font-medium">{value}</dd>
    </div>
  );
}
