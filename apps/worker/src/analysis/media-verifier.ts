import { readFile } from 'node:fs/promises';
import type OpenAI from 'openai';
import pLimit from 'p-limit';
import type { Logger } from 'pino';
import { extractJsonObject, getLlm, jsonFormat } from './llm';

// Media-fit verification (doc 23 §6): before a montage plan is final, each planned
// shot's thumbnail is shown to the vision model with the exact phrase it is supposed
// to illustrate; clear mismatches are dropped. Bounded (montage segments only, 384px
// thumbs, low detail, batched) and it degrades to ACCEPT on any error/timeout —
// verification may never break a render (invariant 7).

const BATCH_SIZE = 8;
const BATCH_PARALLELISM = 3;
const REQUEST_TIMEOUT_MS = 30_000;

export interface FitItem {
  thumbPath: string; // local thumbnail (videos: a representative frame)
  phrase: string; // what this shot must depict
}

const SYSTEM = `You quality-check stock footage picks for an automated video editor.
For each numbered item you get a description and an image (for videos, a frame of the
clip). Answer whether the image plausibly depicts the description. Be LENIENT: answer
false ONLY when the image clearly shows the wrong subject or setting (e.g. a beach for
"crowded subway platform"). Style, mood, color and framing differences are fine.
Return JSON: {"fits": [true/false, ...]} with exactly one boolean per item, in order.`;

const RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['fits'],
  properties: { fits: { type: 'array', items: { type: 'boolean' } } },
};

async function toDataUrl(path: string): Promise<string> {
  const buf = await readFile(path);
  const ext = path.toLowerCase().endsWith('.png') ? 'png' : 'jpeg';
  return `data:image/${ext};base64,${buf.toString('base64')}`;
}

async function verifyBatch(
  client: OpenAI,
  model: string,
  items: readonly FitItem[],
  log: Logger,
  signal?: AbortSignal,
): Promise<boolean[]> {
  const accept = items.map(() => true);
  try {
    const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (!item) continue;
      content.push({ type: 'text', text: `#${i + 1}: ${item.phrase}` });
      content.push({
        type: 'image_url',
        image_url: { url: await toDataUrl(item.thumbPath), detail: 'low' },
      });
    }
    const completion = await client.chat.completions.create(
      {
        model,
        temperature: 0,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content },
        ],
        response_format: jsonFormat('media_fit', RESPONSE_SCHEMA),
      },
      { timeout: REQUEST_TIMEOUT_MS, ...(signal ? { signal } : {}) },
    );
    const raw = completion.choices[0]?.message?.content;
    if (!raw) return accept;
    const parsed = JSON.parse(extractJsonObject(raw)) as { fits?: unknown };
    const fits = Array.isArray(parsed.fits) ? parsed.fits : null;
    if (!fits || fits.length !== items.length) return accept;
    return fits.map((f) => f !== false); // anything non-false counts as a pass
  } catch (err) {
    log.warn({ err, items: items.length }, 'media-fit batch failed — accepting');
    return accept;
  }
}

// Verify every item; returns one boolean per item, in order. No key / any failure ⇒
// all-accept, so this can be called unconditionally.
export async function verifyMediaFit(
  items: readonly FitItem[],
  log: Logger,
  signal?: AbortSignal,
): Promise<boolean[]> {
  if (items.length === 0) return [];
  const llm = getLlm();
  if (!llm.available) return items.map(() => true);
  const client = llm.client;
  const model = llm.visionModel; // must be able to see images (OpenAI: gpt-4o; Ollama: qwen2.5vl)

  const batches: FitItem[][] = [];
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    batches.push(items.slice(i, i + BATCH_SIZE));
  }
  const limit = pLimit(BATCH_PARALLELISM);
  const results = await Promise.all(
    batches.map((batch) => limit(() => verifyBatch(client, model, batch, log, signal))),
  );
  return results.flat();
}
