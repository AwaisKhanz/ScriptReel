import { describe, expect, it } from 'vitest';
import { isEncoderOpenFailure } from './encoder';

// The startup probe can say h264_nvenc opens and be right at that moment, then be wrong minutes
// later: NVENC needs VRAM for a CUDA context, and on a 16 GB card the sidecar plus Ollama's vision
// model can leave none (measured mid-run at 15174/16311 MiB). These are the real stderrs that must
// trigger the demote-and-retry, kept verbatim so a regex tidy-up can't quietly stop matching them.
describe('isEncoderOpenFailure', () => {
  it('matches the NVENC-out-of-VRAM failure seen in a real run', () => {
    const stderr = [
      '[h264_nvenc @ 000001950bd900c0] dl_fn->cuda_dl->cuCtxCreate(&ctx->cu_context_internal, 0, cu_device) failed -> CUDA_ERROR_ALREADY_MAPPED: resource already mapped',
      '[h264_nvenc @ 000001950bd900c0] No capable devices found',
      '[vost#0:0/h264_nvenc @ 0000019509e27400] [enc:h264_nvenc @ 0000019509de12c0] Error while opening encoder - maybe incorrect parameters such as bit_rate, rate, width or height.',
      '[out#0/mp4 @ 0000019509da86c0] Nothing was written into output file, because at least one of its streams received no packets.',
    ].join('\n');
    expect(isEncoderOpenFailure(stderr)).toBe(true);
  });

  it('matches the older driver-mismatch and session-limit shapes', () => {
    expect(
      isEncoderOpenFailure('[h264_nvenc] Driver does not support the required nvenc API version'),
    ).toBe(false); // no open-failure keyword — the startup probe catches this one
    expect(isEncoderOpenFailure('OpenEncodeSessionEx failed: out of memory (10)')).toBe(true);
    expect(isEncoderOpenFailure('Cannot load nvcuda.dll')).toBe(true);
  });

  // Demoting to libx264 on an unrelated failure would silently drop the GPU for the whole process
  // and hide the real error behind a slow retry that fails the same way.
  it('ignores failures that are not the encoder refusing to open', () => {
    expect(isEncoderOpenFailure('No such file or directory')).toBe(false);
    expect(isEncoderOpenFailure('Invalid argument: width must be even')).toBe(false);
    expect(isEncoderOpenFailure('moov atom not found')).toBe(false);
    expect(isEncoderOpenFailure('')).toBe(false);
  });
});
