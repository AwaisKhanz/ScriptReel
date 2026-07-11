import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { paths, rootDir } from '@scriptreel/config';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Only these prefixes are servable (doc 15 §Files). assets/music resolves under the
// repo root; the rest under DATA_DIR.
const ALLOWED: { prefix: string; base: string }[] = [
  { prefix: 'projects', base: paths.dataDir },
  { prefix: 'cache/thumbs', base: paths.dataDir },
  { prefix: 'cache/voice-samples', base: paths.dataDir },
  { prefix: 'assets/music', base: rootDir },
];

const CONTENT_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json',
  '.ass': 'text/plain; charset=utf-8',
};

function contentType(path: string): string {
  const dot = path.lastIndexOf('.');
  return (dot >= 0 && CONTENT_TYPES[path.slice(dot).toLowerCase()]) || 'application/octet-stream';
}

// Reject anything that escapes an allowed prefix (blocks `..`, absolute, symlink escapes).
async function safeResolve(segments: string[]): Promise<string | null> {
  const rel = segments.join('/');
  const allow = ALLOWED.find((a) => rel === a.prefix || rel.startsWith(`${a.prefix}/`));
  if (!allow) return null;
  const resolved = resolve(allow.base, rel);
  const baseWithSep = allow.base.endsWith(sep) ? allow.base : allow.base + sep;
  if (!resolved.startsWith(baseWithSep)) return null;
  try {
    const real = await realpath(resolved);
    if (!real.startsWith(baseWithSep)) return null; // symlink escape
    return real;
  } catch {
    return null; // missing
  }
}

export async function GET(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path: segments } = await params;
  const filePath = await safeResolve(segments);
  if (!filePath) return new NextResponse('not found', { status: 404 });

  const info = await stat(filePath).catch(() => null);
  if (!info?.isFile()) return new NextResponse('not found', { status: 404 });

  const etag = `"${info.mtimeMs.toString(16)}-${info.size.toString(16)}"`;
  if (req.headers.get('if-none-match') === etag) return new NextResponse(null, { status: 304 });

  const type = contentType(filePath);
  const headers = new Headers({
    'Content-Type': type,
    ETag: etag,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=60',
  });

  // HTTP Range — required for <video> seeking.
  const range = req.headers.get('range');
  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    if (match) {
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Number(match[2]) : info.size - 1;
      if (start >= info.size || end >= info.size || start > end) {
        return new NextResponse('range not satisfiable', {
          status: 416,
          headers: { 'Content-Range': `bytes */${info.size}` },
        });
      }
      headers.set('Content-Range', `bytes ${start}-${end}/${info.size}`);
      headers.set('Content-Length', String(end - start + 1));
      const stream = createReadStream(filePath, { start, end });
      return new NextResponse(Readable.toWeb(stream) as ReadableStream, { status: 206, headers });
    }
  }

  headers.set('Content-Length', String(info.size));
  const stream = createReadStream(filePath);
  return new NextResponse(Readable.toWeb(stream) as ReadableStream, { status: 200, headers });
}
