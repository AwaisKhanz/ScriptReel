import { hashObject, invariant } from '@scriptreel/core';
import * as db from '@scriptreel/db';
import { getAnalyzer } from '../analysis/factory';
import { getLlm } from '../analysis/llm';
import { runAnalysisWithReprompt } from '../analysis/run-analysis';
import type { ProjectCtx, Reporter, Stage, StageOutcome } from './context';
import { writeStageJson } from './manifest';

// Real analyze stage (doc 07): OpenAI → verbatim check (one reprompt) → post-pass →
// persist beats + stages/analyze/beats.json.
export const analyzeStage: Stage = {
  name: 'analyze',

  async inputsHash(ctx: ProjectCtx): Promise<string> {
    const project = await db.getProject(ctx.projectId);
    invariant(project, `project ${ctx.projectId} not found`, 'analyze');
    return hashObject({
      stage: 'analyze',
      script: project.script,
      language: ctx.settings.language ?? null,
      pacing: ctx.settings.pacing,
    });
  },

  async run(ctx: ProjectCtx, report: Reporter): Promise<StageOutcome> {
    const project = await db.getProject(ctx.projectId);
    invariant(project, `project ${ctx.projectId} not found`, 'analyze');

    report(10, 'calling the model');
    const analyzer = getAnalyzer(ctx.log);
    const llm = getLlm(); // record the provider/model that actually ran (openai vs ollama)
    const { post, raw } = await runAnalysisWithReprompt(analyzer, {
      input: {
        script: project.script,
        pacing: ctx.settings.pacing,
        ...(ctx.settings.language ? { languageHint: ctx.settings.language } : {}),
      },
      script: project.script,
      ...(ctx.settings.language ? { languageOverride: ctx.settings.language } : {}),
      speed: ctx.settings.speed,
    });

    report(85, `persisting ${post.beats.length} beats`);
    await db.setProjectLanguage(ctx.projectId, post.language);
    await db.replaceBeats(ctx.projectId, post.beats);
    await writeStageJson(ctx.projectId, 'analyze', 'beats.json', {
      analyzer: llm.provider,
      model: llm.textModel,
      reconstruction: post.reconstruction,
      language: post.language,
      musicMood: post.musicMood,
      beats: post.beats,
      raw,
    });

    return {
      artifacts: ['beats.json'],
      meta: {
        analyzer: llm.provider,
        model: llm.textModel,
        beatCount: post.beats.length,
        reconstruction: post.reconstruction,
        language: post.language,
        musicMood: post.musicMood,
      },
    };
  },
};
