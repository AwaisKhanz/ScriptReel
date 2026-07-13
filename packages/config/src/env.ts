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
  DATABASE_URL: z
    .string()
    .min(1)
    .default('postgresql://postgres:postgres@127.0.0.1:54322/postgres'),
  NEXT_PUBLIC_SUPABASE_URL: z.string().min(1).default('http://127.0.0.1:54321'),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().default(''),
  PEXELS_API_KEY: z.string().optional(),
  PIXABAY_API_KEY: z.string().optional(),
  // LLM: OpenAI GPT only — no local LLM (decided 2026-07-10; supersedes doc 07's
  // Gemini/Ollama analyzers). OPENAI_API_KEY is required from Phase 2 onward.
  LLM_PROVIDER: z.enum(['openai']).default('openai'),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().min(1).default('gpt-4o-mini'),
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
