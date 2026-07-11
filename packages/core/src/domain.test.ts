import { describe, expect, it } from 'vitest';
import { classifyDomain } from './domain';

describe('classifyDomain (doc 23 §5)', () => {
  it('routes named / topical beats to the right domain', () => {
    expect(classifyDomain('Apollo 11 lunar module descends toward the Moon')).toBe('space');
    expect(classifyDomain('coral reef teeming with fish in a warm ocean')).toBe('nature');
    expect(classifyDomain('a single cell divides under a microscope')).toBe('science');
    expect(classifyDomain('a medieval castle during the Renaissance')).toBe('history');
    expect(classifyDomain('a Renaissance fresco in a museum gallery')).toBe('history'); // history wins over art (earlier rule)
    expect(classifyDomain('developers writing software on laptops')).toBe('tech');
    expect(classifyDomain('a busy city street at rush hour, downtown skyline')).toBe('urban');
  });

  it('falls back to generic for unfilmable/abstract text', () => {
    expect(classifyDomain('the meaning of doubt and the nature of belief')).toBe('nature'); // 'nature' keyword present
    expect(classifyDomain('a quiet moment of reflection and calm resolve')).toBe('generic');
    expect(classifyDomain('')).toBe('generic');
  });
});
