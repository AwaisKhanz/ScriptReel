'use client';

import { useMutation } from '@tanstack/react-query';
import { type ReactNode, useRef, useState } from 'react';

// Model Playground — a standalone diagnostic screen to poke the sidecar's vision models
// (SigLIP, OCR, InsightFace, DINOv2, Qwen2.5-VL) with your own images. Completely separate
// from the script pipeline; nothing here creates a project or writes a timeline.

type Safe<T> = { ok: true; data: T } | { ok: false; error: string };

interface RunResult {
  ocr: Safe<{ text: string; coverage: number; wordCount: number } | null>;
  siglip: Safe<{ dim: number; textSim: number | null; imageSim: number | null }>;
  dino: Safe<{ dim: number; sim: number | null }> | null;
  face: Safe<{ faceInA: boolean; faceInB: boolean; sim: number | null }> | null;
  vlm: Safe<{
    subjectPresent: boolean;
    shotTypeMatches: boolean;
    eraMatches: boolean;
    contradictingText: boolean;
  }> | null;
}

// Map a raw sidecar error code to a friendly line + the command that enables it.
function friendlyError(error: string): { title: string; hint?: string } {
  if (/E_OCR/.test(error))
    return { title: 'Tesseract not installed', hint: 'brew install tesseract' };
  if (/E_DINO/.test(error)) return { title: 'DINOv2 not installed', hint: 'make identity' };
  if (/E_FACE/.test(error)) return { title: 'InsightFace not installed', hint: 'make identity' };
  if (/E_VLM/.test(error))
    return { title: 'Qwen2.5-VL not installed', hint: 'make vlm — then restart the sidecar' };
  if (/unreachable|ECONNREFUSED|fetch failed|HTTP 5/.test(error))
    return { title: 'Sidecar unreachable', hint: 'start it with `pnpm sidecar`' };
  return { title: error };
}

export default function PlaygroundPage() {
  const [fileA, setFileA] = useState<File | null>(null);
  const [fileB, setFileB] = useState<File | null>(null);
  const [text, setText] = useState('');
  const [era, setEra] = useState('timeless');

  const run = useMutation<RunResult, Error>({
    mutationFn: async () => {
      const body = new FormData();
      if (fileA) body.append('imageA', fileA);
      if (fileB) body.append('imageB', fileB);
      body.append('text', text);
      body.append('era', era);
      const res = await fetch('/api/playground', { method: 'POST', body });
      if (!res.ok) {
        const e = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(e?.error ?? `request failed (${res.status})`);
      }
      return res.json() as Promise<RunResult>;
    },
  });

  const result = run.data;

  return (
    <div className="mx-auto w-full max-w-6xl animate-fade-up">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Model Playground</h1>
        <p className="mt-1 text-sm text-fg-muted">
          Test the vision models directly on your own images — SigLIP matching, OCR / watermark,
          face &amp; landmark identity, and the Qwen2.5-VL checklist. Separate from the script flow;
          nothing is saved to a project.
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,380px)_1fr]">
        {/* ---------- inputs ---------- */}
        <section className="flex flex-col gap-4">
          <ImageDrop
            label="Image"
            hint="required — the image every model runs on"
            file={fileA}
            onChange={setFileA}
          />
          <ImageDrop
            label="Reference image"
            hint="optional — enables image↔image similarity, face &amp; landmark identity"
            file={fileB}
            onChange={setFileB}
          />

          <div>
            <label htmlFor="pg-text" className="mb-1.5 block text-sm font-medium text-fg">
              Description / query
            </label>
            <textarea
              id="pg-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={2}
              placeholder="e.g. Albert Einstein — a historical portrait"
              className="w-full resize-none rounded-lg border border-border bg-surface px-3 py-2 text-sm text-fg placeholder:text-fg-subtle outline-none transition-colors duration-[var(--dur-fast)] focus:border-accent"
            />
            <p className="mt-1 text-xs text-fg-subtle">
              Drives the SigLIP text↔image score and the VLM subject check.
            </p>
          </div>

          <div>
            <label htmlFor="pg-era" className="mb-1.5 block text-sm font-medium text-fg">
              Era <span className="font-normal text-fg-subtle">(VLM)</span>
            </label>
            <select
              id="pg-era"
              value={era}
              onChange={(e) => setEra(e.target.value)}
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-fg outline-none transition-colors duration-[var(--dur-fast)] focus:border-accent"
            >
              <option value="timeless">timeless (nature / space / abstract)</option>
              <option value="modern">modern</option>
              <option value="historical">historical</option>
            </select>
          </div>

          <button
            type="button"
            disabled={!fileA || run.isPending}
            onClick={() => run.mutate()}
            className="brand-gradient flex h-11 items-center justify-center gap-2 rounded-xl text-sm font-semibold text-white shadow-[var(--shadow-glow)] transition-transform duration-[var(--dur-fast)] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {run.isPending ? (
              <>
                <span className="size-4 animate-spin-slow rounded-full border-2 border-white/40 border-t-white" />
                Running models…
              </>
            ) : (
              'Run models'
            )}
          </button>
          {run.isError && (
            <p className="text-sm text-danger">{friendlyError(run.error.message).title}</p>
          )}
          {run.isPending && (
            <p className="text-xs text-fg-subtle">
              First VLM run loads ~2.2 GB and can take ~30 s.
            </p>
          )}
        </section>

        {/* ---------- results ---------- */}
        <section className="flex flex-col gap-4">
          {!result && !run.isPending && (
            <div className="flex h-full min-h-64 flex-col items-center justify-center rounded-xl border border-dashed border-border bg-surface/40 p-8 text-center">
              <BeakerIcon className="size-8 text-fg-subtle" />
              <p className="mt-3 text-sm font-medium text-fg">Results appear here</p>
              <p className="mt-1 max-w-xs text-xs text-fg-subtle">
                Add an image and hit “Run models”. Add a reference image and a description to
                exercise every model.
              </p>
            </div>
          )}

          {result && (
            <>
              <ResultCard title="SigLIP" subtitle="semantic image ↔ text / image match">
                {result.siglip.ok ? (
                  <div className="space-y-3">
                    {result.siglip.data.textSim !== null ? (
                      <SimRow label="Text ↔ image" value={result.siglip.data.textSim} kind="text" />
                    ) : (
                      <Muted>Add a description above for the text↔image score.</Muted>
                    )}
                    {result.siglip.data.imageSim !== null ? (
                      <SimRow
                        label="Image ↔ reference"
                        value={result.siglip.data.imageSim}
                        kind="image"
                      />
                    ) : (
                      <Muted>Add a reference image for the image↔image score.</Muted>
                    )}
                  </div>
                ) : (
                  <ErrorState error={result.siglip.error} />
                )}
              </ResultCard>

              <ResultCard title="OCR" subtitle="Tesseract — burned-in text &amp; watermarks">
                {result.ocr.ok ? (
                  result.ocr.data ? (
                    <div className="space-y-3">
                      <SimRow
                        label="Text coverage"
                        value={result.ocr.data.coverage}
                        kind="coverage"
                      />
                      <div>
                        <div className="mb-1 text-xs font-medium text-fg-muted">
                          Detected text · {result.ocr.data.wordCount} words
                        </div>
                        <div className="max-h-28 overflow-auto rounded-lg bg-surface-2 px-3 py-2 font-mono text-xs text-fg">
                          {result.ocr.data.text || (
                            <span className="text-fg-subtle">— no text detected —</span>
                          )}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <Muted>No result.</Muted>
                  )
                ) : (
                  <ErrorState error={result.ocr.error} />
                )}
              </ResultCard>

              {result.face && (
                <ResultCard title="InsightFace" subtitle="face identity vs the reference image">
                  {result.face.ok ? (
                    <div className="space-y-3">
                      <div className="flex gap-2">
                        <FaceChip label="Face in image" present={result.face.data.faceInA} />
                        <FaceChip label="Face in reference" present={result.face.data.faceInB} />
                      </div>
                      {result.face.data.sim !== null ? (
                        <SimRow label="Face similarity" value={result.face.data.sim} kind="face" />
                      ) : (
                        <Muted>Need a detectable face in both images to compare.</Muted>
                      )}
                    </div>
                  ) : (
                    <ErrorState error={result.face.error} />
                  )}
                </ResultCard>
              )}

              {result.dino && (
                <ResultCard title="DINOv2" subtitle="landmark / artwork identity vs the reference">
                  {result.dino.ok ? (
                    result.dino.data.sim !== null ? (
                      <SimRow label="Image similarity" value={result.dino.data.sim} kind="dino" />
                    ) : (
                      <Muted>Could not embed one of the images.</Muted>
                    )
                  ) : (
                    <ErrorState error={result.dino.error} />
                  )}
                </ResultCard>
              )}

              {result.vlm && (
                <ResultCard title="Qwen2.5-VL" subtitle="strict checklist on the image">
                  {result.vlm.ok ? (
                    <div className="grid grid-cols-2 gap-2">
                      <VlmChip label="Subject present" good={result.vlm.data.subjectPresent} />
                      <VlmChip label="Shot framing" good={result.vlm.data.shotTypeMatches} />
                      <VlmChip label="Era matches" good={result.vlm.data.eraMatches} />
                      <VlmChip
                        label="Contradicting text"
                        good={!result.vlm.data.contradictingText}
                        goodLabel="none"
                        badLabel="present"
                      />
                    </div>
                  ) : (
                    <ErrorState error={result.vlm.error} />
                  )}
                </ResultCard>
              )}
              {!result.vlm && (
                <Muted className="px-1">
                  Add a description above to run the Qwen2.5-VL checklist.
                </Muted>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

/* ---------- pieces ---------- */

function ImageDrop({
  label,
  hint,
  file,
  onChange,
}: {
  label: string;
  hint: string;
  file: File | null;
  onChange: (f: File | null) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const url = file ? URL.createObjectURL(file) : null;
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-sm font-medium text-fg">{label}</span>
        {file && (
          <button
            type="button"
            onClick={() => onChange(null)}
            className="text-xs text-fg-subtle transition-colors duration-[var(--dur-fast)] hover:text-danger"
          >
            clear
          </button>
        )}
      </div>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const f = e.dataTransfer.files?.[0];
          if (f?.type.startsWith('image/')) onChange(f);
        }}
        className="group relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-xl border border-dashed border-border bg-surface transition-colors duration-[var(--dur-fast)] hover:border-accent"
      >
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt={label} className="size-full object-contain" />
        ) : (
          <div className="flex flex-col items-center gap-1.5 px-4 py-6 text-center">
            <UploadIcon className="size-6 text-fg-subtle group-hover:text-accent" />
            <span className="text-xs font-medium text-fg-muted">Click or drop an image</span>
            <span className="text-[11px] text-fg-subtle">{hint}</span>
          </div>
        )}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => onChange(e.target.files?.[0] ?? null)}
      />
    </div>
  );
}

function ResultCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <div className="animate-scale-in rounded-xl border border-border bg-surface p-4 shadow-[var(--shadow-sm)]">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold text-fg">{title}</h2>
        <span className="text-xs text-fg-subtle">{subtitle}</span>
      </div>
      {children}
    </div>
  );
}

// Qualitative band per metric — rough, honest guidance, not the pipeline's exact τ.
function band(value: number, kind: string): { label: string; tone: string; frac: number } {
  const table: Record<string, [number, number]> = {
    text: [0.1, 0.18], // SigLIP text↔image — raw cosine is compressed; a genuine terse match
    //                    lands ~0.12–0.18, a clear miss ~0.05, so bands sit lower than intuition
    image: [0.6, 0.8], // SigLIP image↔image
    dino: [0.45, 0.6], // DINOv2 image↔image
    face: [0.28, 0.45], // InsightFace ArcFace cosine
    coverage: [0.05, 0.2], // OCR text area — higher = more text/watermark
  };
  const [lo, hi] = table[kind] ?? [0.3, 0.6];
  const frac = Math.max(0, Math.min(1, value));
  if (kind === 'coverage') {
    if (value >= hi) return { label: 'heavy', tone: 'text-danger', frac };
    if (value >= lo) return { label: 'some', tone: 'text-warning', frac };
    return { label: 'minimal', tone: 'text-success', frac };
  }
  if (value >= hi) return { label: 'strong', tone: 'text-success', frac };
  if (value >= lo) return { label: 'moderate', tone: 'text-warning', frac };
  return { label: 'weak', tone: 'text-fg-subtle', frac };
}

function SimRow({ label, value, kind }: { label: string; value: number; kind: string }) {
  const b = band(value, kind);
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-xs font-medium text-fg-muted">{label}</span>
        <span className="font-mono text-sm text-fg">
          {value.toFixed(3)} <span className={`text-xs font-sans ${b.tone}`}>· {b.label}</span>
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-[var(--dur-slow)]"
          style={{ width: `${Math.round(b.frac * 100)}%` }}
        />
      </div>
    </div>
  );
}

function FaceChip({ label, present }: { label: string; present: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
        present ? 'bg-accent-quiet text-accent' : 'bg-surface-2 text-fg-subtle'
      }`}
    >
      <span className={`size-1.5 rounded-full ${present ? 'bg-accent' : 'bg-fg-subtle'}`} />
      {label}: {present ? 'yes' : 'no'}
    </span>
  );
}

function VlmChip({
  label,
  good,
  goodLabel = 'yes',
  badLabel = 'no',
}: {
  label: string;
  good: boolean;
  goodLabel?: string;
  badLabel?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg bg-surface-2 px-3 py-2">
      <span className="text-xs text-fg-muted">{label}</span>
      <span className={`text-xs font-semibold ${good ? 'text-success' : 'text-danger'}`}>
        {good ? goodLabel : badLabel}
      </span>
    </div>
  );
}

function Muted({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <p className={`text-xs text-fg-subtle ${className}`}>{children}</p>;
}

function ErrorState({ error }: { error: string }) {
  const f = friendlyError(error);
  return (
    <div className="rounded-lg border border-border bg-surface-2 px-3 py-2.5">
      <p className="text-xs font-medium text-fg-muted">{f.title}</p>
      {f.hint && <p className="mt-0.5 font-mono text-[11px] text-fg-subtle">{f.hint}</p>}
    </div>
  );
}

/* ---------- icons ---------- */

function UploadIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 16V4M7 9l5-5 5 5M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
    </svg>
  );
}

function BeakerIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M9 3h6M10 3v6l-5.5 9.5A2 2 0 0 0 6 21h12a2 2 0 0 0 1.5-3.5L14 9V3M7.5 14h9" />
    </svg>
  );
}
