import { createHash } from 'node:crypto';

// Deterministic JSON: object keys sorted so equal objects serialize identically.
// Pure computation (no I/O) — belongs in core.
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortValue(record[key]);
    }
    return sorted;
  }
  return value;
}

export function sha1Hex(input: string): string {
  return createHash('sha1').update(input).digest('hex');
}

// sha1 of the stable serialization — used for settings_hash and stage inputsHash.
export function hashObject(value: unknown): string {
  return sha1Hex(stableStringify(value));
}
