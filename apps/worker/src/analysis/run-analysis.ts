import {
  type AnalysisResult,
  type AnalyzeInput,
  PipelineError,
  type PostProcessOutput,
  postProcessAnalysis,
  type ScriptAnalyzer,
} from '@scriptreel/core';

export const VERBATIM_RETRY_HINT =
  'Your beats did not reconstruct the script exactly when their text fields are concatenated in order. Re-segment so the joined text equals the script verbatim, changing only whitespace between beats.';

export interface AnalysisRunParams {
  input: AnalyzeInput;
  script: string;
  languageOverride?: string;
  speed: number;
}

export interface AnalysisRun {
  post: PostProcessOutput;
  raw: AnalysisResult;
}

// One analyze call → post-pass; any E_LLM_SCHEMA (schema or verbatim) triggers
// exactly one reprompt, then propagates E_LLM_SCHEMA (doc 07). Analyzer is injected
// so this is unit-testable without a network.
export async function runAnalysisWithReprompt(
  analyzer: ScriptAnalyzer,
  params: AnalysisRunParams,
): Promise<AnalysisRun> {
  const attempt = async (hint?: string): Promise<AnalysisRun> => {
    const raw = await analyzer.analyze(params.input, hint ? { retryHint: hint } : {});
    const post = postProcessAnalysis({
      script: params.script,
      result: raw,
      language: params.languageOverride ?? raw.language,
      speed: params.speed,
    });
    return { post, raw };
  };

  try {
    return await attempt();
  } catch (err) {
    if (!(err instanceof PipelineError) || err.code !== 'E_LLM_SCHEMA') {
      throw err;
    }
    return attempt(VERBATIM_RETRY_HINT);
  }
}
