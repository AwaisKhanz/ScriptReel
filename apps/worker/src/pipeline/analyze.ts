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
      // Bump whenever the prompt or the post-pass changes what a beat looks like. The manifest
      // hash is the ONLY re-run gate — no route deletes manifests — so without this a reworked
      // prompt silently serves the beats the old prompt produced, and the change looks inert.
      logic: 'prompt-2',
      script: project.script,
      language: ctx.settings.language ?? null,
      pacing: ctx.settings.pacing,
      // speed feeds estimateSeconds → est_seconds, which decides the merge/split boundaries —
      // so it changes the beats themselves, not just narration timing. Omitting it meant a
      // speed change re-ran tts against beats still segmented for the old speed.
      speed: ctx.settings.speed,
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

    // The reprompt already failed once; these beats keep the model's visuals over text the
    // arithmetic re-slice moved underneath them. Ship them (invariant 7) but say so.
    const warnings =
      post.reconstruction === 'proportional'
        ? [
            'analyze: the model did not reproduce the script verbatim even after a reprompt; beat text was re-sliced proportionally, so each beat may show visuals designed for a different sentence',
          ]
        : [];

    return {
      artifacts: ['beats.json'],
      warnings,
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
