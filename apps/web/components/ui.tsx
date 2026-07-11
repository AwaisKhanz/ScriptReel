import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'subtle' | 'ghost' | 'outline' | 'danger';
type Size = 'sm' | 'md' | 'lg';

const VARIANTS: Record<Variant, string> = {
  primary:
    'brand-gradient text-white font-semibold shadow-[var(--shadow-glow)] hover:brightness-[1.06]',
  subtle: 'bg-surface-2 text-fg border border-border hover:border-border-strong hover:bg-surface-3',
  ghost: 'text-fg-muted hover:bg-surface-2 hover:text-fg',
  outline: 'border border-border-strong text-fg hover:bg-surface-2',
  danger: 'bg-danger/12 text-danger border border-danger/30 hover:bg-danger/20',
};

const SIZES: Record<Size, string> = {
  sm: 'h-9 px-3 text-sm',
  md: 'h-10 px-4 text-sm',
  lg: 'h-11 px-5 text-base',
};

export function Button({
  variant = 'subtle',
  size = 'md',
  className = '',
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return (
    <button
      className={`inline-flex items-center justify-center gap-2 rounded-xl transition-all duration-[var(--dur-fast)] active:scale-[0.98] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-50 ${SIZES[size]} ${VARIANTS[variant]} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

export function Card({
  className = '',
  children,
  interactive = false,
  accent = false,
  bare = false,
}: {
  className?: string;
  children: ReactNode;
  interactive?: boolean;
  accent?: boolean;
  bare?: boolean;
}) {
  return (
    <div
      className={`relative overflow-hidden rounded-xl border border-border bg-surface shadow-[var(--shadow-sm)] ${bare ? '' : 'p-5'} ${interactive ? 'card-interactive' : ''} ${className}`}
    >
      {accent && <span className="accent-rule absolute inset-x-0 top-0 h-[3px]" />}
      {children}
    </div>
  );
}

type Tone = 'neutral' | 'accent' | 'success' | 'progress' | 'danger' | 'warning';

const TONES: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-fg-muted border-border',
  accent: 'bg-accent-quiet text-accent border-accent/30',
  success: 'bg-success/12 text-success border-success/30',
  progress: 'bg-progress/12 text-progress border-progress/30',
  warning: 'bg-warning/12 text-warning border-warning/30',
  danger: 'bg-danger/12 text-danger border-danger/30',
};

export function Badge({
  tone = 'neutral',
  className = '',
  children,
}: {
  tone?: Tone;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${TONES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export function Dot({ tone = 'neutral', pulse = false }: { tone?: Tone; pulse?: boolean }) {
  const bg: Record<Tone, string> = {
    neutral: 'bg-fg-subtle',
    accent: 'bg-accent',
    success: 'bg-success',
    progress: 'bg-progress',
    warning: 'bg-warning',
    danger: 'bg-danger',
  };
  return (
    <span className={`relative flex size-2 rounded-full ${bg[tone]}`}>
      {pulse && (
        <span
          className={`absolute inline-flex size-full animate-ping rounded-full ${bg[tone]} opacity-60`}
        />
      )}
    </span>
  );
}

export function ProgressBar({
  value,
  tone = 'accent',
  className = '',
}: {
  value: number;
  tone?: 'accent' | 'progress' | 'success' | 'danger';
  className?: string;
}) {
  const fill: Record<string, string> = {
    accent: 'brand-gradient',
    progress: 'bg-progress',
    success: 'bg-success',
    danger: 'bg-danger',
  };
  return (
    <div className={`h-2 overflow-hidden rounded-full bg-surface-2 ${className}`}>
      <div
        className={`h-full rounded-full ${fill[tone]} transition-[width] duration-500 ease-[var(--ease-out)]`}
        style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
      />
    </div>
  );
}

export function Spinner({ className = '' }: { className?: string }) {
  return (
    <span
      className={`inline-block size-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent ${className}`}
    />
  );
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`skeleton rounded-xl ${className}`} />;
}

export function ErrorPanel({
  title,
  detail,
  onRetry,
}: {
  title: string;
  detail?: string;
  onRetry?: () => void;
}) {
  return (
    <Card className="border-danger/30" accent={false}>
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-danger/12 text-danger">
          <svg
            viewBox="0 0 24 24"
            className="size-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden
          >
            <path
              d="M12 9v4M12 17h.01M10.3 3.9 2 18a2 2 0 0 0 1.7 3h16.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-danger">{title}</div>
          {detail && (
            <pre className="mt-2 max-h-40 overflow-auto rounded-lg bg-bg p-3 font-mono text-xs text-fg-muted">
              {detail}
            </pre>
          )}
          {onRetry && (
            <Button variant="outline" size="sm" className="mt-3" onClick={onRetry}>
              Try again
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}
