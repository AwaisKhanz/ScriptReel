// The no-strike license gate (doc 23 §3). Archive sources carry per-item licenses;
// this is the single place that decides whether an asset may be used, so every
// provider and the credits builder agree. Policy, not per-provider magic.
//
// Allow: Public Domain / CC0 / CC BY (attribution auto-added to credits), plus the
// stock providers' own commercial licenses (Pexels/Pixabay). Reject ShareAlike
// (would infect the output license), NonCommercial, NoDerivatives (we trim/pan =
// a derivative), and anything unknown/unstated (a missing license is a reject).

export type LicenseClass = {
  allowed: boolean;
  spdx: string; // normalized id, e.g. 'CC0-1.0' | 'CC-BY-4.0' | 'PD' | 'CC-BY-SA' | 'unknown'
  requiresAttribution: boolean;
  label: string;
};

const reject = (spdx: string, label: string): LicenseClass => ({
  allowed: false,
  spdx,
  requiresAttribution: false,
  label,
});
const allow = (spdx: string, label: string, attribution: boolean): LicenseClass => ({
  allowed: true,
  spdx,
  requiresAttribution: attribution,
  label,
});

// Accepts a license label ("CC BY 4.0"), a code ("by-sa"), or a URL
// ("https://creativecommons.org/licenses/by-nc/4.0/"). Case/spacing-insensitive.
export function classifyLicense(raw: string | null | undefined): LicenseClass {
  const s = (raw ?? '').toLowerCase().trim();
  if (s === '') return reject('unknown', 'unstated license');

  // Public domain family — no attribution required.
  if (/\bcc0\b|creativecommons\.org\/publicdomain\/zero|\bzero\b/.test(s)) {
    return allow('CC0-1.0', 'CC0 (public domain)', false);
  }
  if (
    /public[\s-]?domain|\bpdm\b|publicdomain\/mark|no known copyright|no known restrictions|government work|us[\s-]?gov/.test(
      s,
    )
  ) {
    return allow('PD', 'public domain', false);
  }

  // Stock providers' own free-commercial licenses.
  if (s.includes('pexels')) return allow('Pexels', 'Pexels License', false);
  if (s.includes('pixabay')) return allow('Pixabay', 'Pixabay License', false);

  // Creative Commons restrictions — order matters (by-nc-sa etc. contain "by").
  const hasCc = /\bcc\b|\bby\b|creativecommons/.test(s);
  if (hasCc) {
    if (/\bnc\b|non[\s-]?commercial|by-nc/.test(s)) return reject('CC-BY-NC', 'CC non-commercial');
    if (/\bnd\b|no[\s-]?deriv|by-nd/.test(s)) return reject('CC-BY-ND', 'CC no-derivatives');
    if (/\bsa\b|share[\s-]?alike|by-sa/.test(s)) return reject('CC-BY-SA', 'CC share-alike');
    if (/\bby\b|by\//.test(s)) return allow('CC-BY', 'CC BY (attribution required)', true);
  }

  return reject('unknown', `unrecognized license: ${raw}`);
}

// Convenience for the search-stage gate: keep only admissible candidates.
export function isLicenseAllowed(raw: string | null | undefined): boolean {
  return classifyLicense(raw).allowed;
}
