import {
  type MediaProvider,
  PipelineError,
  type RawCandidate,
  type SearchQuery,
} from '@scriptreel/core';
import { z } from 'zod';

const Stream = z.object({
  url: z.string(),
  width: z.number(),
  height: z.number(),
  thumbnail: z.string().nullish(),
});
const PVideo = z.object({
  id: z.number(),
  duration: z.number(),
  pageURL: z.string(),
  user: z.string(),
  videos: z.object({
    large: Stream,
    medium: Stream,
    small: Stream.nullish(),
    tiny: Stream.nullish(),
  }),
});
const PVideoResponse = z.object({ hits: z.array(PVideo) });
const PImage = z.object({
  id: z.number(),
  pageURL: z.string(),
  user: z.string(),
  imageWidth: z.number(),
  imageHeight: z.number(),
  webformatURL: z.string(),
  largeImageURL: z.string(),
});
const PImageResponse = z.object({ hits: z.array(PImage) });

export function mapPixabayVideos(json: unknown, target: number): RawCandidate[] {
  const data = PVideoResponse.parse(json);
  return data.hits.map((v) => {
    const { large, medium, tiny } = v.videos;
    const stream = large.height >= target ? large : medium.height >= target ? medium : large;
    return {
      provider: 'pixabay' as const,
      providerId: String(v.id),
      kind: 'video' as const,
      width: stream.width,
      height: stream.height,
      duration: v.duration,
      thumbUrl: large.thumbnail ?? medium.thumbnail ?? tiny?.thumbnail ?? '',
      downloadUrl: stream.url,
      pageUrl: v.pageURL,
      author: v.user || 'Unknown',
      license: 'Pixabay Content License',
      meta: { tinyUrl: tiny?.url },
    };
  });
}

export function mapPixabayImages(json: unknown): RawCandidate[] {
  const data = PImageResponse.parse(json);
  return data.hits.map((i) => ({
    provider: 'pixabay' as const,
    providerId: String(i.id),
    kind: 'image' as const,
    width: i.imageWidth,
    height: i.imageHeight,
    thumbUrl: i.webformatURL,
    downloadUrl: i.largeImageURL,
    pageUrl: i.pageURL,
    author: i.user || 'Unknown',
    license: 'Pixabay Content License',
  }));
}

export class PixabayProvider implements MediaProvider {
  readonly id = 'pixabay' as const;

  async search(query: SearchQuery, apiKey: string): Promise<RawCandidate[]> {
    const key = apiKey;
    if (!key) throw new PipelineError('E_ENV', 'search', 'PIXABAY_API_KEY is not set');
    const url = new URL(
      query.kind === 'video' ? 'https://pixabay.com/api/videos/' : 'https://pixabay.com/api/',
    );
    url.searchParams.set('key', key);
    url.searchParams.set('q', query.query);
    url.searchParams.set('per_page', String(query.perPage));
    url.searchParams.set('safesearch', 'true');
    if (query.kind === 'image') {
      url.searchParams.set('image_type', 'photo');
      url.searchParams.set(
        'orientation',
        query.orientation === 'portrait' ? 'vertical' : 'horizontal',
      );
    }

    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      throw new PipelineError(
        'E_PROVIDER_HTTP',
        'search',
        `pixabay ${query.kind} → HTTP ${res.status}`,
      );
    }
    const json: unknown = await res.json();
    const target = query.orientation === 'portrait' ? 1920 : 1080;
    return query.kind === 'video' ? mapPixabayVideos(json, target) : mapPixabayImages(json);
  }
}
