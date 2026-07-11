import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import './globals.css';
import { Providers } from './providers';

export const metadata: Metadata = {
  title: 'ScriptReel',
  description: 'Paste a script. Get a video.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-bg font-sans text-fg antialiased">
        <Providers>
          <header className="sticky top-0 z-20 border-b border-border bg-bg/80 backdrop-blur">
            <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
              <Link href="/" className="text-lg font-semibold tracking-tight">
                Script<span className="border-b-2 border-accent">Reel</span>
              </Link>
              <nav className="flex items-center gap-1 text-sm text-fg-muted">
                <Link href="/" className="rounded-md px-3 py-1.5 hover:bg-surface-2 hover:text-fg">
                  Projects
                </Link>
                <Link
                  href="/settings"
                  className="rounded-md px-3 py-1.5 hover:bg-surface-2 hover:text-fg"
                >
                  Settings
                </Link>
              </nav>
            </div>
          </header>
          <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
        </Providers>
      </body>
    </html>
  );
}
