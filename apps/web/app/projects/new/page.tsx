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
  const scriptValid = script.length >= 50 && script.length <= 6000;

  const langVoices = (voices.data?.voices ?? []).filter((v) => v.language === voiceLang);

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
      const body = await create.json();
      if (!create.ok) throw new Error(body.error ?? 'create failed');
      const id = body.project.id as string;
      const gen = await fetch(`/api/projects/${id}/generate`, { method: 'POST' });
      if (!gen.ok) throw new Error((await gen.json()).error ?? 'generate failed');
      router.push(`/projects/${id}`);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      setSubmitting(false);
    }
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_280px]">
      <div className="space-y-5">
        <div className="flex items-center gap-2">
          {[1, 2, 3].map((n) => (
            <div key={n} className="flex items-center gap-2">
              <span
                className={`flex size-7 items-center justify-center rounded-full text-xs font-medium ${
                  step === n
                    ? 'bg-accent text-[#0A0C10]'
                    : step > n
                      ? 'bg-success/20 text-success'
                      : 'bg-surface-2 text-fg-subtle'
                }`}
              >
                {n}
              </span>
              <span className={`text-sm ${step === n ? 'text-fg' : 'text-fg-subtle'}`}>
                {['Script', 'Voice', 'Look & sound'][n - 1]}
              </span>
              {n < 3 && <span className="mx-1 h-px w-6 bg-border" />}
            </div>
          ))}
        </div>

        {step === 1 && (
          <Card className="space-y-4">
            <Field label="Script" hint="50–6,000 characters. Plain text.">
              <textarea
                value={script}
                onChange={(e) => setScript(e.target.value)}
                rows={12}
                placeholder="Paste your script…"
                className="w-full resize-y rounded-md border border-border bg-bg p-3 font-mono text-sm leading-relaxed outline-none focus:border-border-strong focus:ring-2 focus:ring-accent/40"
              />
            </Field>
            <div className="flex flex-wrap items-center gap-4 text-xs text-fg-subtle">
              <span>{script.length} chars</span>
              <span>{words} words</span>
              <span>≈ {fmtDuration(narration)} narration</span>
              <span>≈ {beats} beats</span>
              {script.length > 6000 && <span className="text-danger">trim to 6,000</span>}
            </div>
            <Field label="Title" hint="Optional — defaults to the first few words.">
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="w-full rounded-md border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-border-strong focus:ring-2 focus:ring-accent/40"
              />
            </Field>
          </Card>
        )}

        {step === 2 && (
          <Card className="space-y-4">
            <Field label="Voice language">
              <Pills
                value={voiceLang}
                options={['en-US', 'en-GB', 'es', 'fr', 'hi', 'it', 'pt-BR', 'ja', 'zh']}
                onChange={setVoiceLang}
              />
            </Field>
            {voices.isLoading ? (
              <Spinner />
            ) : (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {langVoices.map((v) => (
                  <div
                    key={v.id}
                    className={`flex items-center justify-between gap-2 rounded-md border px-3 py-2 ${
                      s.voice === v.id
                        ? 'border-accent bg-accent-quiet'
                        : 'border-border bg-surface-2'
                    }`}
                  >
                    <button
                      type="button"
                      className="min-w-0 text-left"
                      onClick={() => set('voice', v.id)}
                    >
                      <div className="truncate text-sm font-medium">{v.displayName}</div>
                      <div className="text-xs text-fg-subtle">{v.gender}</div>
                    </button>
                    <button
                      type="button"
                      onClick={() => play(`/api/voices/${v.id}/sample`)}
                      className="shrink-0 rounded-full bg-surface px-2 py-1 text-xs text-accent hover:bg-border"
                    >
                      ▶
                    </button>
                  </div>
                ))}
              </div>
            )}
            <Field label={`Speed — ≈ ${fmtDuration(narration)} narration`}>
              <Slider
                value={s.speed}
                min={0.8}
                max={1.3}
                step={0.05}
                onChange={(v) => set('speed', v)}
                suffix="×"
              />
            </Field>
            <Field label="Pause between beats">
              <Slider
                value={s.pauseMs}
                min={0}
                max={600}
                step={10}
                onChange={(v) => set('pauseMs', v)}
                suffix="ms"
              />
            </Field>
          </Card>
        )}

        {step === 3 && (
          <Card className="space-y-5">
            <Field label="Aspect ratio">
              <AspectToggle value={s.aspect} onChange={(v) => set('aspect', v)} />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Quality">
                <Pills value={s.quality} options={QUALITIES} onChange={(v) => set('quality', v)} />
              </Field>
              <Field label="Pacing">
                <Pills value={s.pacing} options={PACINGS} onChange={(v) => set('pacing', v)} />
              </Field>
              <Field label="Media">
                <Pills
                  value={s.mediaPreference}
                  options={MEDIA_PREFERENCES}
                  onChange={(v) => set('mediaPreference', v)}
                />
              </Field>
              <Field label="Transitions">
                <Pills
                  value={s.transitionStyle}
                  options={TRANSITION_STYLES}
                  onChange={(v) => set('transitionStyle', v)}
                />
              </Field>
            </div>

            <Field label="Subtitles" hint="Live preview matches the burned output.">
              <Pills
                value={s.subtitlePreset}
                options={SUBTITLE_PRESETS}
                onChange={(v) => set('subtitlePreset', v)}
              />
            </Field>
            <SubtitlePreviewCanvas
              preset={s.subtitlePreset}
              aspect={s.aspect}
              position={s.subtitlePosition}
            />
            {s.subtitlePreset !== 'none' && (
              <Field label="Position">
                <Pills
                  value={s.subtitlePosition}
                  options={SUBTITLE_POSITIONS}
                  onChange={(v) => set('subtitlePosition', v)}
                />
              </Field>
            )}

            <Field label="Music mood">
              <Pills
                value={s.musicMood}
                options={MUSIC_MOODS}
                onChange={(v) => {
                  set('musicMood', v);
                  set('musicTrackId', '');
                }}
              />
            </Field>
            {music.data && s.musicMood !== 'none' && (
              <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                {music.data.tracks
                  .filter((t) => s.musicMood === 'auto' || t.moods.includes(s.musicMood))
                  .slice(0, 9)
                  .map((t) => (
                    <div
                      key={t.id}
                      className={`flex items-center justify-between gap-1 rounded-md border px-2 py-1.5 text-xs ${
                        s.musicTrackId === t.id
                          ? 'border-accent bg-accent-quiet'
                          : 'border-border bg-surface-2'
                      }`}
                    >
                      <button
                        type="button"
                        className="min-w-0 truncate text-left"
                        onClick={() => set('musicTrackId', t.id)}
                      >
                        {t.title}
                      </button>
                      <button
                        type="button"
                        onClick={() => play(`/api/files/assets/music/${t.id}.mp3`)}
                        className="shrink-0 text-accent"
                      >
                        ▶
                      </button>
                    </div>
                  ))}
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
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={s.reviewBeforeRender}
                onChange={(e) => set('reviewBeforeRender', e.target.checked)}
                className="size-4 accent-[var(--color-accent)]"
              />
              Review before render (storyboard)
            </label>
          </Card>
        )}

        {error && <p className="text-sm text-danger">{error}</p>}

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
              onClick={() => setStep((n) => n + 1)}
              disabled={step === 1 && !scriptValid}
            >
              Next
            </Button>
          ) : (
            <Button variant="primary" onClick={submit} disabled={submitting || !scriptValid}>
              {submitting ? <Spinner /> : 'Generate'}
            </Button>
          )}
        </div>
      </div>

      <Card className="h-max space-y-3 lg:sticky lg:top-20">
        <h3 className="text-sm font-medium">Summary</h3>
        <Row label="Duration" value={`≈ ${fmtDuration(narration)}`} />
        <Row label="Beats" value={`≈ ${beats}`} />
        <Row label="Pexels requests" value={`≈ ${beats}`} />
        <Row label="Aspect" value={s.aspect} />
        <Row label="Render est." value={s.quality === 'draft' ? '≈ 2 min' : '≈ 4 min'} />
        <div className="pt-1">
          <Badge tone={s.reviewBeforeRender ? 'accent' : 'neutral'}>
            {s.reviewBeforeRender ? 'Review before render' : 'Straight to render'}
          </Badge>
        </div>
      </Card>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-fg-subtle">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}
