import { readFile } from 'node:fs/promises';
import type OpenAI from 'openai';
import pLimit from 'p-limit';
import type { Logger } from 'pino';
import { extractJsonObject, getLlm, jsonFormat, type LlmProvider } from './llm';

// Media-fit verification (doc 23 §6): before a montage plan is final, each planned
// shot's thumbnail is shown to the vision model with the exact phrase it is supposed
// to illustrate; clear mismatches are dropped. Bounded (montage segments only, 384px
// thumbs, low detail, batched) and it degrades to ACCEPT on any error/timeout —
// verification may never break a render (invariant 7).

// Batching/timeout per provider — a hosted API and a local model are not the same machine, and the
// binding limit is different for each. Hosted: throughput. Local: the CONTEXT WINDOW.
//
// The old values (8 images × 3 concurrent × 30s) are hosted-API values, and on Ollama they made
// this gate dead on arrival — every batch failed, every run, so it degraded to accept-everything
// and verified nothing. Measured here, not guessed:
//   - a 4-image request is 4326 prompt tokens against Ollama's 4096 default context; the server
//     rejects it outright ("exceeds the available context size"). 8 images is ~8k — double the
//     window. The request was never servable, at any timeout.
//   - Ollama also serves ONE model at a time, so three "parallel" requests queue behind each other
//     while sharing one 30s deadline. That is why all three used to die within 123ms of each other.
// An image costs ~1000 tokens at detail:'low', so 2 per request (~2.3k + prompt) fits 4096 with
// room to spare. Serialised, because the queue exists whether or not we pretend otherwise, and a
// timeout that survives a cold q8 8B load on a GPU that is already busy with the sidecar.
//
// Raising OLLAMA_CONTEXT_LENGTH would allow bigger batches, but the default has to work: the
// OpenAI-compatible endpoint gives no way to set num_ctx per request, so the code cannot negotiate
// it — it can only fit inside it.
const LIMITS: Record<LlmProvider, { batchSize: number; parallelism: number; timeoutMs: number }> = {
  openai: { batchSize: 8, parallelism: 3, timeoutMs: 30_000 },
  ollama: { batchSize: 2, parallelism: 1, timeoutMs: 180_000 },
};

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
  signal: AbortSignal | undefined,
  timeoutMs: number,
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
      { timeout: timeoutMs, ...(signal ? { signal } : {}) },
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

  const limits = LIMITS[llm.provider];

  const batches: FitItem[][] = [];
  for (let i = 0; i < items.length; i += limits.batchSize) {
    batches.push(items.slice(i, i + limits.batchSize));
  }
  const limit = pLimit(limits.parallelism);
  const results = await Promise.all(
    batches.map((batch) =>
      limit(() => verifyBatch(client, model, batch, log, signal, limits.timeoutMs)),
    ),
  );
  return results.flat();
}
