import { describe, expect, it } from 'vitest';
import { extractJsonObject } from './llm';

// extractJsonObject makes local-model replies safe to JSON.parse — reasoning-capable models
// (qwen3, deepseek-r1) can wrap the answer in <think>…</think> or stray prose even in JSON mode.

describe('extractJsonObject', () => {
  it('passes clean JSON straight through', () => {
    expect(extractJsonObject('{"a":1}')).toBe('{"a":1}');
  });

  it('strips a <think> block a reasoning model emits before the JSON', () => {
    const raw = '<think>Let me weigh the options…</think>\n{"fits":[true,false]}';
    expect(JSON.parse(extractJsonObject(raw))).toEqual({ fits: [true, false] });
  });

  it('slices the JSON object out of surrounding prose', () => {
    const raw = 'Here is the result:\n{"era":"modern"}\nHope that helps!';
    expect(JSON.parse(extractJsonObject(raw))).toEqual({ era: 'modern' });
  });

  it('handles multi-line nested JSON after a think block', () => {
    const raw = '<think>x</think>{\n "beats": [{"text":"a"}]\n}';
    expect(JSON.parse(extractJsonObject(raw))).toEqual({ beats: [{ text: 'a' }] });
  });
});
