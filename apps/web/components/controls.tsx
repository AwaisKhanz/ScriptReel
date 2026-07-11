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
    <label className="block space-y-1.5">
      <span className="text-sm font-medium">{label}</span>
      {hint && <span className="block text-xs text-fg-subtle">{hint}</span>}
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
    <div className="flex flex-wrap gap-1.5">
      {opts.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`rounded-md border px-3 py-1.5 text-sm capitalize transition-colors ${
            value === o.value
              ? 'border-accent bg-accent-quiet text-accent'
              : 'border-border bg-surface-2 text-fg-muted hover:text-fg'
          }`}
        >
          {o.label}
        </button>
      ))}
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
    <div className="flex items-center gap-3">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-surface-2 accent-[var(--color-accent)]"
      />
      <span className="w-16 text-right font-mono text-xs text-fg-muted">
        {value}
        {suffix}
      </span>
    </div>
  );
}

export function AspectToggle({
  value,
  onChange,
}: {
  value: '16:9' | '9:16' | '1:1';
  onChange: (v: '16:9' | '9:16' | '1:1') => void;
}) {
  const shapes: { value: '16:9' | '9:16' | '1:1'; w: number; h: number }[] = [
    { value: '16:9', w: 44, h: 25 },
    { value: '9:16', w: 25, h: 44 },
    { value: '1:1', w: 34, h: 34 },
  ];
  return (
    <div className="flex items-end gap-3">
      {shapes.map((s) => (
        <button
          key={s.value}
          type="button"
          onClick={() => onChange(s.value)}
          className="flex flex-col items-center gap-1.5"
        >
          <span
            style={{ width: s.w, height: s.h }}
            className={`rounded border-2 transition-colors ${
              value === s.value
                ? 'border-accent bg-accent-quiet'
                : 'border-border-strong bg-surface-2'
            }`}
          />
          <span className={`text-xs ${value === s.value ? 'text-accent' : 'text-fg-subtle'}`}>
            {s.value}
          </span>
        </button>
      ))}
    </div>
  );
}
