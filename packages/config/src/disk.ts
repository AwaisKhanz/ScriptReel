import { readdir, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';

// Free bytes available on the filesystem holding `path` (doc 14 disk guard).
export async function freeDiskBytes(path: string): Promise<number> {
  const s = await statfs(path);
  return s.bavail * s.bsize;
}

// Total size of a directory tree, in bytes. Missing dir → 0. Symlinks are not
// followed (we only ever size our own cache tree).
export async function dirSizeBytes(dir: string): Promise<number> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (!entries) return 0; // missing dir
  let total = 0;
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await dirSizeBytes(full);
    } else if (entry.isFile()) {
      total += await stat(full)
        .then((s) => s.size)
        .catch(() => 0); // vanished mid-walk
    }
  }
  return total;
}
