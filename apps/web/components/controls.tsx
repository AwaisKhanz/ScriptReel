'use client';

import type { ReactNode } from 'react';

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is passed in via children
    <label className="block space-y-2">
      <span className="flex items-baseline gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-fg-muted">{label}</span>
        {hint && <span className="text-xs font-normal normal-case text-fg-subtle">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

export function Pills<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: readonly T[] | { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  const opts = options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o));
  return (
    <div className="flex flex-wrap gap-2">
      {opts.map((o) => {
        const active = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-all duration-[var(--dur-fast)] active:scale-[0.97] ${
              active
                ? 'border-accent/40 bg-accent-quiet text-accent shadow-[var(--shadow-xs)]'
                : 'border-border bg-surface-2 text-fg-muted hover:border-border-strong hover:text-fg'
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function Slider({
  value,
  min,
  max,
  step,
  onChange,
  suffix,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  suffix?: string;
}) {
  return (
    <div className="flex items-center gap-4">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-surface-3 accent-[var(--color-accent)]"
      />
      <span className="w-16 shrink-0 rounded-md bg-surface-2 py-1 text-center font-mono text-xs font-medium text-fg">
        {value}
        {suffix}
      </span>
    </div>
  );
}

const SHAPES: { value: '16:9' | '9:16' | '1:1'; w: number; h: number; label: string }[] = [
  { value: '16:9', w: 42, h: 24, label: 'Landscape' },
  { value: '9:16', w: 24, h: 42, label: 'Portrait' },
  { value: '1:1', w: 32, h: 32, label: 'Square' },
];

export function AspectToggle({
  value,
  onChange,
}: {
  value: '16:9' | '9:16' | '1:1';
  onChange: (v: '16:9' | '9:16' | '1:1') => void;
}) {
  return (
    <div className="grid grid-cols-3 gap-3">
      {SHAPES.map((s) => {
        const active = value === s.value;
        return (
          <button
            key={s.value}
            type="button"
            onClick={() => onChange(s.value)}
            className={`flex flex-col items-center gap-2 rounded-xl border p-4 transition-all duration-[var(--dur-fast)] active:scale-[0.98] ${
              active
                ? 'border-accent/40 bg-accent-quiet'
                : 'border-border bg-surface-2 hover:border-border-strong'
            }`}
          >
            <span className="flex h-12 items-center justify-center">
              <span
                style={{ width: s.w, height: s.h }}
                className={`rounded-md border-2 transition-colors duration-[var(--dur-fast)] ${
                  active ? 'border-accent bg-accent/15' : 'border-border-strong'
                }`}
              />
            </span>
            <span className={`text-sm font-semibold ${active ? 'text-accent' : 'text-fg'}`}>
              {s.value}
            </span>
            <span className="text-xs text-fg-subtle">{s.label}</span>
          </button>
        );
      })}
    </div>
  );
}
