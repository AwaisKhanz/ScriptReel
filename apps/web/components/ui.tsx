import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'ghost' | 'danger' | 'subtle';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-[#0A0C10] hover:bg-accent-hover font-medium',
  danger: 'bg-danger/15 text-danger hover:bg-danger/25 border border-danger/30',
  ghost: 'text-fg-muted hover:bg-surface-2 hover:text-fg border border-border',
  subtle: 'bg-surface-2 text-fg hover:bg-border border border-border',
};

export function Button({
  variant = 'subtle',
  className = '',
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      className={`inline-flex h-10 items-center justify-center gap-2 rounded-md px-4 text-sm transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50 ${VARIANTS[variant]} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

export function Card({ className = '', children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={`rounded-lg border border-border bg-surface p-5 shadow-[var(--shadow-card)] ${className}`}
    >
      {children}
    </div>
  );
}

export function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'accent' | 'success' | 'progress' | 'danger';
  children: ReactNode;
}) {
  const tones: Record<string, string> = {
    neutral: 'bg-surface-2 text-fg-muted border-border',
    accent: 'bg-accent-quiet text-accent border-accent/30',
    success: 'bg-success/15 text-success border-success/30',
    progress: 'bg-progress/15 text-progress border-progress/30',
    danger: 'bg-danger/15 text-danger border-danger/30',
  };
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function Spinner({ className = '' }: { className?: string }) {
  return (
    <span
      className={`inline-block size-4 animate-spin rounded-full border-2 border-fg-subtle border-t-accent ${className}`}
    />
  );
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-surface-2 ${className}`} />;
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
    <Card className="border-danger/30">
      <div className="text-sm font-medium text-danger">{title}</div>
      {detail && (
        <pre className="mt-2 max-h-40 overflow-auto rounded-md bg-bg p-3 font-mono text-xs text-fg-muted">
          {detail}
        </pre>
      )}
      {onRetry && (
        <Button variant="ghost" className="mt-3" onClick={onRetry}>
          Retry
        </Button>
      )}
    </Card>
  );
}
