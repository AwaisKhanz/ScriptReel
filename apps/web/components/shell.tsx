'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

/* ---------- brand mark ---------- */

export function Logo({ className = '' }: { className?: string }) {
  return (
    <Link href="/" className={`group inline-flex items-center gap-2.5 ${className}`}>
      <span className="brand-gradient flex size-8 items-center justify-center rounded-[10px] shadow-[var(--shadow-glow)] transition-transform duration-[var(--dur-base)] group-hover:scale-105">
        <PlayIcon className="size-4 text-white" />
      </span>
      <span className="text-lg font-semibold tracking-tight">
        Script<span className="text-gradient">Reel</span>
      </span>
    </Link>
  );
}

/* ---------- sidebar ---------- */

const NAV = [
  { href: '/', label: 'Dashboard', icon: GridIcon, match: (p: string) => p === '/' },
  {
    href: '/projects/new',
    label: 'New Project',
    icon: FilmIcon,
    match: (p: string) => p.startsWith('/projects/new'),
  },
  {
    href: '/settings',
    label: 'Settings',
    icon: SlidersIcon,
    match: (p: string) => p.startsWith('/settings'),
  },
];

export function Sidebar() {
  const pathname = usePathname();
  return (
    <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r border-border bg-surface/60 px-4 py-5 backdrop-blur-xl lg:flex">
      <div className="px-2">
        <Logo />
      </div>

      <Link
        href="/projects/new"
        className="brand-gradient mt-6 flex h-11 items-center justify-center gap-2 rounded-xl text-sm font-semibold text-white shadow-[var(--shadow-glow)] transition-transform duration-[var(--dur-fast)] active:scale-[0.98]"
      >
        <PlusIcon className="size-4" />
        New Project
      </Link>

      <nav className="mt-6 flex flex-col gap-1">
        {NAV.map((item) => {
          const active = item.match(pathname);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors duration-[var(--dur-fast)] ${
                active
                  ? 'bg-accent-quiet text-accent'
                  : 'text-fg-muted hover:bg-surface-2 hover:text-fg'
              }`}
            >
              <Icon
                className={`size-[18px] ${active ? 'text-accent' : 'text-fg-subtle group-hover:text-fg-muted'}`}
              />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="mt-auto rounded-xl border border-border bg-surface p-3.5">
        <div className="flex items-center gap-2">
          <span className="size-2 animate-pulse rounded-full bg-success" />
          <span className="text-xs font-semibold text-fg">Local render engine</span>
        </div>
        <dl className="mt-2 space-y-1 text-xs text-fg-subtle">
          <div className="flex justify-between">
            <dt>Hardware</dt>
            <dd className="font-mono text-fg-muted">M3 Pro</dd>
          </div>
          <div className="flex justify-between">
            <dt>Encoder</dt>
            <dd className="font-mono text-fg-muted">VideoToolbox</dd>
          </div>
          <div className="flex justify-between">
            <dt>Cost / video</dt>
            <dd className="font-mono text-success">$0</dd>
          </div>
        </dl>
      </div>
    </aside>
  );
}

/* ---------- topbar ---------- */

const TITLES: { test: (p: string) => boolean; label: string }[] = [
  { test: (p) => p === '/', label: 'Dashboard' },
  { test: (p) => p.startsWith('/projects/new'), label: 'New Project' },
  { test: (p) => p.startsWith('/projects/'), label: 'Project' },
  { test: (p) => p.startsWith('/settings'), label: 'Settings' },
];

export function Topbar() {
  const pathname = usePathname();
  const title = TITLES.find((t) => t.test(pathname))?.label ?? 'ScriptReel';
  return (
    <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-border bg-bg/70 px-5 backdrop-blur-xl sm:px-8">
      <div className="lg:hidden">
        <Logo />
      </div>
      <h1 className="hidden text-base font-semibold tracking-tight lg:block">{title}</h1>
      <div className="ml-auto flex items-center gap-2.5">
        <SystemsPill />
        <ThemeToggle />
        <span className="brand-gradient hidden size-9 items-center justify-center rounded-full text-xs font-bold text-white sm:flex">
          AO
        </span>
      </div>
    </header>
  );
}

/* ---------- systems pill (real /api/health) ---------- */

interface Health {
  ok: boolean;
  checks?: {
    db: { ok: boolean };
    sidecar: { ok: boolean };
    ffmpeg: { ok: boolean };
    keys: { ok: boolean };
  };
}

function SystemsPill() {
  const { data, isLoading, isError } = useQuery<Health>({
    queryKey: ['health'],
    queryFn: () => fetch('/api/health').then((r) => r.json()),
    refetchInterval: 30_000,
    staleTime: 20_000,
  });

  const ok = data?.ok === true;
  const label = isLoading ? 'Checking…' : isError || !ok ? 'Degraded' : 'All systems ok';
  const tone = isLoading ? 'text-fg-subtle' : ok ? 'text-success' : 'text-warning';
  const dot = isLoading ? 'bg-fg-subtle' : ok ? 'bg-success' : 'bg-warning';

  return (
    <Link
      href="/settings"
      className="flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1.5 text-xs font-medium transition-colors duration-[var(--dur-fast)] hover:border-border-strong"
      title="System health"
    >
      <span className={`relative flex size-2 ${dot} rounded-full`}>
        {ok && (
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-60" />
        )}
      </span>
      <span className={`hidden sm:inline ${tone}`}>{label}</span>
    </Link>
  );
}

/* ---------- theme toggle ---------- */

export function ThemeToggle() {
  const [dark, setDark] = useState<boolean | null>(null);

  useEffect(() => {
    setDark(document.documentElement.classList.contains('dark'));
  }, []);

  function toggle() {
    const next = !document.documentElement.classList.contains('dark');
    document.documentElement.classList.toggle('dark', next);
    try {
      localStorage.setItem('theme', next ? 'dark' : 'light');
    } catch {}
    setDark(next);
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="Toggle theme"
      className="flex size-9 items-center justify-center rounded-full border border-border bg-surface text-fg-muted transition-colors duration-[var(--dur-fast)] hover:border-border-strong hover:text-fg"
    >
      {dark === null ? (
        <span className="size-[18px]" />
      ) : dark ? (
        <SunIcon className="size-[18px]" />
      ) : (
        <MoonIcon className="size-[18px]" />
      )}
    </button>
  );
}

/* ---------- icons (inline, no dependency) ---------- */

type IconProps = { className?: string };
const base = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

function PlayIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
      <path d="M8 5.5v13l11-6.5z" />
    </svg>
  );
}
function GridIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...base} aria-hidden>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  );
}
function FilmIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...base} aria-hidden>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4" />
    </svg>
  );
}
function SlidersIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...base} aria-hidden>
      <path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h8M16 18h4" />
      <circle cx="16" cy="6" r="2" />
      <circle cx="8" cy="12" r="2" />
      <circle cx="14" cy="18" r="2" />
    </svg>
  );
}
function PlusIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...base} aria-hidden>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
function SunIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...base} aria-hidden>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}
function MoonIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...base} aria-hidden>
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  );
}
