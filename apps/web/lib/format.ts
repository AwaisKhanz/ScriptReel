export function fmtDuration(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return '—';
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function fmtBytes(bytes: number | null | undefined): string {
  if (!bytes) return '—';
  const mb = bytes / 1_048_576;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

const WORDS_PER_SEC = 2.7; // en baseline (doc 10); rough estimate for the wizard rail

export function estimateNarrationSec(script: string, speed = 1): number {
  const words = script.trim().split(/\s+/).filter(Boolean).length;
  return words / (WORDS_PER_SEC * speed);
}

export function estimateBeats(script: string): number {
  // ~1 beat per sentence, min 1 (matches the analyze segmenter's rough density).
  const sentences = script.split(/[.!?]+\s/).filter((s) => s.trim().length > 0).length;
  return Math.max(1, sentences);
}

export function fileUrl(absoluteOrRelPath: string): string {
  // Map a stored absolute path under DATA_DIR/repo to the /api/files route.
  const marker = ['/data/projects/', '/data/cache/', '/assets/music/'].find((m) =>
    absoluteOrRelPath.includes(m),
  );
  if (!marker) return absoluteOrRelPath;
  const idx = absoluteOrRelPath.indexOf(marker);
  const rel = absoluteOrRelPath.slice(idx + (marker.startsWith('/data/') ? '/data/'.length : 1));
  return `/api/files/${rel}`;
}
