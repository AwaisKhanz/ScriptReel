import { env } from '@scriptreel/config';
import {
  type MediaProvider,
  PipelineError,
  type RawCandidate,
  type SearchQuery,
} from '@scriptreel/core';
import { z } from 'zod';

const VideoFile = z.object({
  id: z.number(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  link: z.string(),
});
const Video = z.object({
  id: z.number(),
  width: z.number(),
  height: z.number(),
  duration: z.number(),
  url: z.string(),
  image: z.string(),
  user: z.object({ name: z.string() }).nullish(),
  video_files: z.array(VideoFile),
  video_pictures: z.array(z.object({ picture: z.string() })).nullish(),
});
const VideoResponse = z.object({ videos: z.array(Video) });
const Photo = z.object({
  id: z.number(),
  width: z.number(),
  height: z.number(),
  url: z.string(),
  photographer: z.string(),
  src: z.object({ large2x: z.string(), medium: z.string() }),
});
const PhotoResponse = z.object({ photos: z.array(Photo) });

function targetHeight(orientation: string): number {
  return orientation === 'portrait' ? 1920 : 1080;
}

// Pick the video file closest-above the final height, else the largest (doc 08).
function bestFile(
  files: z.infer<typeof VideoFile>[],
  target: number,
): z.infer<typeof VideoFile> | null {
  const withHeight = files.filter((f) => (f.height ?? 0) > 0);
  if (withHeight.length === 0) return files[0] ?? null;
  const above = withHeight
    .filter((f) => (f.height ?? 0) >= target)
    .sort((a, b) => (a.height ?? 0) - (b.height ?? 0));
  if (above[0]) return above[0];
  return withHeight.sort((a, b) => (b.height ?? 0) - (a.height ?? 0))[0] ?? null;
}

export function mapPexelsVideos(json: unknown, orientation: string): RawCandidate[] {
  const data = VideoResponse.parse(json);
  const target = targetHeight(orientation);
  const out: RawCandidate[] = [];
  for (const v of data.videos) {
    const file = bestFile(v.video_files, target);
    if (!file) continue;
    out.push({
      provider: 'pexels',
      providerId: String(v.id),
      kind: 'video',
      width: file.width ?? v.width,
      height: file.height ?? v.height,
      duration: v.duration,
      thumbUrl: v.video_pictures?.[0]?.picture ?? v.image,
      downloadUrl: file.link,
      pageUrl: v.url,
      author: v.user?.name ?? 'Unknown',
      license: 'Pexels License',
    });
  }
  return out;
}

export function mapPexelsPhotos(json: unknown): RawCandidate[] {
  const data = PhotoResponse.parse(json);
  return data.photos.map((p) => ({
    provider: 'pexels' as const,
    providerId: String(p.id),
    kind: 'image' as const,
    width: p.width,
    height: p.height,
    thumbUrl: p.src.medium,
    downloadUrl: p.src.large2x,
    pageUrl: p.url,
    author: p.photographer,
    license: 'Pexels License',
  }));
}

export class PexelsProvider implements MediaProvider {
  readonly id = 'pexels' as const;

  async search(query: SearchQuery): Promise<RawCandidate[]> {
    const key = env.PEXELS_API_KEY;
    if (!key) throw new PipelineError('E_ENV', 'search', 'PEXELS_API_KEY is not set');
    const base =
      query.kind === 'video'
        ? 'https://api.pexels.com/videos/search'
        : 'https://api.pexels.com/v1/search';
    const url = new URL(base);
    url.searchParams.set('query', query.query);
    url.searchParams.set('orientation', query.orientation);
    url.searchParams.set('per_page', String(query.perPage));
    if (query.kind === 'video') url.searchParams.set('size', 'medium');

    const res = await fetch(url, {
      headers: { Authorization: key },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new PipelineError(
        'E_PROVIDER_HTTP',
        'search',
        `pexels ${query.kind} → HTTP ${res.status}`,
      );
    }
    const json: unknown = await res.json();
    return query.kind === 'video'
      ? mapPexelsVideos(json, query.orientation)
      : mapPexelsPhotos(json);
  }
}
