import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

// Load the repo-root .env (doc 03) with Node's built-in parser — no dependency.
// Walk up from cwd so it works whichever package the process starts in. Real
// environment variables always win over the file (Node does not override them).
function findAndLoadDotEnv(): string {
  let dir = process.cwd();
  for (;;) {
    const candidate = resolve(dir, '.env');
    if (existsSync(candidate)) {
      try {
        process.loadEnvFile(candidate);
      } catch {
        // Malformed/unreadable .env — the schema check below reports what's missing.
      }
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return process.cwd();
    }
    dir = parent;
  }
}

// Directory that holds .env (the repo root). Relative paths (DATA_DIR) anchor
// here, not to process.cwd() — the worker, CLI and web all start from different
// directories but must share one DATA_DIR.
export const rootDir = findAndLoadDotEnv();

// Single source of truth for process configuration (doc 03). Infra vars carry the
// doc 19 defaults so a freshly copied .env.example boots; provider keys stay
// optional until the phase that needs them tightens the schema.
const EnvSchema = z.object({
  DATA_DIR: z.string().min(1).default('./data'),
  SIDECAR_URL: z.string().min(1).default('http://127.0.0.1:8484'),
  // Isolated Chatterbox voice server (services/voice) — cloned natural narrators. Speaks the same
  // /tts contract as the sidecar; the tts stage routes chatterbox-engine voices here. Kept separate
  // from the sidecar because Chatterbox pins a different torch/cu128 build (see services/voice).
  CHATTERBOX_URL: z.string().min(1).default('http://127.0.0.1:8585'),
  DATABASE_URL: z
    .string()
    .min(1)
    .default('postgresql://postgres:postgres@127.0.0.1:54322/postgres'),
  NEXT_PUBLIC_SUPABASE_URL: z.string().min(1).default('http://127.0.0.1:54321'),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().default(''),
  // Stock-provider API keys (Pexels, Pixabay, Flickr, …) live in the DB via Settings → API Keys
  // (provider_keys), NOT here — one consistent source for every keyed provider. See
  // packages/core/src/provider-auth.ts + apps/worker/src/providers/quota-guard.ts.
  // LLM provider (analyze + knowledge expansion + media-fit verification). `openai` uses the
  // cloud GPT (needs OPENAI_API_KEY); `ollama` uses a LOCAL, OpenAI-API-compatible server (owner
  // re-enabled local LLMs 2026-07-13, having an RTX-class GPU + Ollama). See analysis/llm.ts.
  LLM_PROVIDER: z.enum(['openai', 'ollama']).default('openai'),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().min(1).default('gpt-4o-mini'),
  // How entities are enriched for search (doc 25 §2a) — decoupled from LLM_PROVIDER so a cloud
  // analyze doesn't force the slow, rate-limited Wikidata path. 'llm' asks the configured model for
  // aliases/related-terms/era (fast; ~cents on cloud, free+local on Ollama) — the default, because
  // the Wikidata barrier can add minutes to a large script. 'wikidata' is the factual graph (most
  // accurate P31 sense-check, slowest). 'none' skips expansion entirely and searches on the
  // analyzer's own searchTerms (fastest, zero extra calls).
  KNOWLEDGE_SOURCE: z.enum(['llm', 'wikidata', 'none']).default('llm'),
  // Local LLM via Ollama (active when LLM_PROVIDER=ollama). Text model drives analyze + knowledge
  // expansion; the vision model drives media-fit verification (it must be able to see images).
  // Use a NON-reasoning model for text — reasoning models (qwen3, deepseek-r1) "think" before
  // answering, which is slow and muddies the structured JSON; coder models are best at the schema.
  OLLAMA_BASE_URL: z.string().min(1).default('http://localhost:11434/v1'),
  OLLAMA_MODEL: z.string().min(1).default('qwen2.5-coder:14b'),
  OLLAMA_VISION_MODEL: z.string().min(1).default('qwen2.5vl:7b'),
  FFMPEG_PATH: z.string().optional(),
  // Video encoder override. Default is platform-aware (VideoToolbox on Apple, libx264 elsewhere);
  // set e.g. `h264_nvenc` on an NVIDIA box for GPU encoding (see apps/worker/src/ffmpeg/encoder.ts).
  VIDEO_ENCODER: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment — fix .env (see .env.example):\n${issues}`);
  }
  return parsed.data;
}

export const env: Env = loadEnv();

// True when DATABASE_URL points at a LOCAL Postgres (localhost/127.0.0.1). Local Postgres has no TLS
// and ~100 max_connections; Supabase Cloud requires TLS and its session pooler caps clients at 15.
// Every DB connector (postgres.js in packages/db, pg-boss in the worker + web) keys its ssl + pool
// size off this so one env var flips the whole app between backends. See packages/db/src/client.ts.
export const isLocalDatabase = /@(?:localhost|127\.0\.0\.1)[:/]/.test(env.DATABASE_URL);
