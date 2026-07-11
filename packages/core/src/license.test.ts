import { describe, expect, it } from 'vitest';
import { classifyLicense, isLicenseAllowed } from './license';

describe('classifyLicense (doc 23 no-strike gate)', () => {
  it('allows public-domain / CC0 with no attribution', () => {
    for (const raw of [
      'CC0',
      'cc0 1.0',
      'https://creativecommons.org/publicdomain/zero/1.0/',
      'Public Domain',
      'public-domain',
      'pdm',
      'https://creativecommons.org/publicdomain/mark/1.0/',
      'No known copyright restrictions',
      'United States Government Work',
    ]) {
      const c = classifyLicense(raw);
      expect(c.allowed, raw).toBe(true);
      expect(c.requiresAttribution, raw).toBe(false);
    }
  });

  it('allows CC BY but requires attribution', () => {
    for (const raw of [
      'CC BY',
      'by',
      'CC-BY-4.0',
      'https://creativecommons.org/licenses/by/4.0/',
    ]) {
      const c = classifyLicense(raw);
      expect(c.allowed, raw).toBe(true);
      expect(c.requiresAttribution, raw).toBe(true);
    }
  });

  it('rejects ShareAlike, NonCommercial, NoDerivatives (incl. combined)', () => {
    for (const raw of [
      'CC BY-SA 3.0',
      'by-sa',
      'https://creativecommons.org/licenses/by-sa/4.0/',
      'CC BY-NC',
      'by-nc-sa',
      'https://creativecommons.org/licenses/by-nc-nd/4.0/',
      'CC BY-ND',
    ]) {
      expect(isLicenseAllowed(raw), raw).toBe(false);
    }
  });

  it('rejects unknown / unstated as a hard reject', () => {
    expect(isLicenseAllowed('')).toBe(false);
    expect(isLicenseAllowed(null)).toBe(false);
    expect(isLicenseAllowed('All Rights Reserved')).toBe(false);
    expect(isLicenseAllowed('© 2024 Someone')).toBe(false);
  });

  it('allows the stock providers own licenses', () => {
    expect(classifyLicense('Pexels License').allowed).toBe(true);
    expect(classifyLicense('Pixabay License').requiresAttribution).toBe(false);
  });
});
