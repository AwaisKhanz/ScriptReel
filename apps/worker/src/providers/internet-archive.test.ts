import { describe, expect, it } from 'vitest';
import { type IaFile, parseDurationSec, pickVideoFile } from './internet-archive';

function file(name: string, size?: string, length?: string): IaFile {
  return { name, size, length };
}

describe('pickVideoFile', () => {
  it('picks the smallest in-range mp4', () => {
    const files: IaFile[] = [
      file('big.mp4', '250000000'),
      file('small.mp4', '5000000'),
      file('mid.mp4', '40000000'),
    ];
    expect(pickVideoFile(files)?.name).toBe('small.mp4');
  });

  it('skips mp4s larger than 300 MB when a smaller one is in range', () => {
    const files: IaFile[] = [file('huge.mp4', '400000000'), file('ok.mp4', '9000000')];
    expect(pickVideoFile(files)?.name).toBe('ok.mp4');
  });

  it('also skips mp4s smaller than the ~200 KB floor', () => {
    const files: IaFile[] = [file('tiny.mp4', '1000'), file('ok.mp4', '3000000')];
    expect(pickVideoFile(files)?.name).toBe('ok.mp4');
  });

  it('skips files that are not mp4', () => {
    const files: IaFile[] = [
      file('movie.ogv', '5000000'),
      file('thumb.gif', '300000'),
      file('clip.mp4', '8000000'),
    ];
    expect(pickVideoFile(files)?.name).toBe('clip.mp4');
  });

  it('matches the .mp4 extension case-insensitively', () => {
    expect(pickVideoFile([file('CLIP.MP4', '4000000')])?.name).toBe('CLIP.MP4');
  });

  it('returns null when there is no mp4', () => {
    const files: IaFile[] = [file('movie.ogv', '5000000'), file('archive.zip', '9000000')];
    expect(pickVideoFile(files)).toBeNull();
  });

  it('falls back to the smallest mp4 when none is in the size range', () => {
    const files: IaFile[] = [file('a.mp4', '400000000'), file('b.mp4', '500000000')];
    expect(pickVideoFile(files)?.name).toBe('a.mp4');
  });
});

describe('parseDurationSec', () => {
  it('parses a float-seconds string', () => {
    expect(parseDurationSec('213.4')).toBeCloseTo(213.4);
  });

  it('parses MM:SS', () => {
    expect(parseDurationSec('3:37')).toBe(217);
  });

  it('parses H:MM:SS', () => {
    expect(parseDurationSec('1:02:03')).toBe(3723);
  });

  it('falls back to 60 for garbage, empty, or missing input', () => {
    expect(parseDurationSec('not-a-duration')).toBe(60);
    expect(parseDurationSec('1:ab')).toBe(60);
    expect(parseDurationSec('')).toBe(60);
    expect(parseDurationSec(null)).toBe(60);
    expect(parseDurationSec(undefined)).toBe(60);
  });
});
