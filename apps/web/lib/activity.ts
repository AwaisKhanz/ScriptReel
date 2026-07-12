// Structured pipeline activity events (doc 16). The worker writes pipeline_runs.detail
// as small JSON events ({op, ...}); older/phase details stay plain strings. This is
// the single place that turns either form into a human line for the run screen.

export interface ActivityEvent {
  op: string;
  provider?: string;
  kind?: string;
  query?: string;
  found?: number;
  beat?: number;
  of?: number;
  done?: number;
  total?: number;
  n?: number;
}

export function parseDetail(detail: string | null | undefined): ActivityEvent | null {
  if (detail?.[0] !== '{') return null;
  try {
    const parsed: unknown = JSON.parse(detail);
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as { op?: unknown }).op === 'string'
    ) {
      return parsed as ActivityEvent;
    }
  } catch {
    // plain-text detail — fall through
  }
  return null;
}

// Human line for a detail value: structured events get a friendly sentence, plain
// strings pass through untouched.
export function detailText(detail: string | null | undefined): string | null {
  const e = parseDetail(detail);
  if (!e) return detail ?? null;
  switch (e.op) {
    case 'search':
      return `Searching ${e.provider} ${e.kind === 'video' ? 'videos' : 'photos'} · “${e.query}” — ${e.found} found`;
    case 'beat':
      return `Beat ${e.beat}/${e.of} sourced`;
    case 'embed':
      return `Analyzing visuals ${e.done}/${e.total}`;
    case 'select':
      return `Matching beat ${e.beat}/${e.of}`;
    case 'download':
      return `Downloading ${e.provider} ${e.kind === 'video' ? 'clip' : 'image'} · ${e.n} fetched`;
    case 'normalize':
      return `Cutting clip ${e.beat}/${e.of}`;
    case 'tts':
      return `Narrating beat ${e.beat}/${e.of}`;
    case 'verify':
      return `Checking media fit ${e.done}/${e.total}`;
    default:
      return null;
  }
}
