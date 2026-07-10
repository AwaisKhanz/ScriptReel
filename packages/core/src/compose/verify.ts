import { PipelineError } from '../errors';

// Post-render assertions (doc 13 §Post-render). Pure so the failure path is unit-
// testable: any mismatch throws E_COMPOSE_VERIFY, which the compose stage surfaces.

export interface RenderProbe {
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  sampleRate: number;
  bytes: number;
}

export interface RenderExpectation {
  durationSec: number; // narration length
  width: number;
  height: number;
  driftToleranceMs?: number; // default 100 (doc 13 / doc 21)
}

export function assertRenderInvariants(actual: RenderProbe, expected: RenderExpectation): void {
  const fail = (message: string): never => {
    throw new PipelineError('E_COMPOSE_VERIFY', 'compose', message);
  };
  const driftMs = Math.abs(actual.durationSec - expected.durationSec) * 1000;
  if (driftMs > (expected.driftToleranceMs ?? 100)) {
    fail(`A/V drift ${driftMs.toFixed(1)}ms exceeds tolerance`);
  }
  if (actual.width !== expected.width || actual.height !== expected.height) {
    fail(`geometry ${actual.width}x${actual.height} != ${expected.width}x${expected.height}`);
  }
  if (Math.abs(actual.fps - 30) >= 1) fail(`fps ${actual.fps} != 30`);
  if (actual.sampleRate !== 48_000) fail(`audio ${actual.sampleRate}Hz != 48000`);
  if (actual.bytes <= 0) fail('render is empty');
}
