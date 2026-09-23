// tests/helpers/contract-copies.ts — finding every copy of a duplicated file,
// and naming the ones that have drifted.
//
// Several files in this cache are duplicated by hand on purpose: a copy lives
// here, and another is handed to the Sabiá server, which reads the same
// bytes with no shared code. Hand-kept duplicates drift, and the only defence
// is a tripwire that fails when they do. These are the tripwire's two halves,
// kept in one place because a tripwire copied between test files is itself a
// duplicate that can drift.
//
// Copies are FOUND BY NAME rather than named by path, for three reasons. The
// other copy lives outside this package and is not part of a clean checkout,
// so it may be absent and may move. Searching also catches a third copy
// appearing, which naming one path would not. And a path to it would put a
// workflow directory into a test that ships, where nobody reading this package
// has any reason to know that directory exists.

import * as fs from 'fs';
import * as path from 'path';

/** Directories that hold build output or dependencies, never a contract copy. */
const SKIP = new Set(['node_modules', '.git', 'dist', 'target', 'out', 'coverage']);

/** Deep enough for this tree with room to spare; a bound, not a guarantee. */
const MAX_DEPTH = 8;

/** The repository root, from this helper's own location. */
export const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/** Every file called `fileName` under `root`, as absolute paths. */
export function findCopies(root: string, fileName: string): string[] {
  const found: string[] = [];
  const walk = (directory: string, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name)) walk(full, depth + 1);
      } else if (entry.name === fileName) {
        found.push(path.resolve(full));
      }
    }
  };
  walk(root, 0);
  return found;
}

/**
 * The copies whose bytes are not exactly `canonical`.
 *
 * BYTES, with no normalisation of any kind — not line endings, not a trailing
 * newline, not whitespace. The other repository reads the bytes, so a copy that
 * differs only in how its lines end is a copy that differs, and the one real
 * drift found so far was exactly that: a file saved with CRLF against a copy
 * that is LF by construction.
 */
export function differingCopies(copies: readonly string[], canonical: Buffer): string[] {
  return copies.filter((file) => !fs.readFileSync(file).equals(canonical));
}

/**
 * One line saying what a tripwire actually compared.
 *
 * Printed always, because the failure mode worth guarding against is a green
 * test that checked nothing: on a clean checkout the other copy is legitimately
 * absent, and that must be said rather than passed over in silence.
 */
export function describeComparison(fileName: string, compared: readonly string[]): string {
  return compared.length === 0
    ? `no copy of ${fileName} found to compare against — byte identity with the copy ` +
        'handed to the server repository was NOT checked, because the artifacts it lives ' +
        'with are not part of a clean checkout'
    : `compared ${compared.length} cop${compared.length === 1 ? 'y' : 'ies'} of ${fileName}: ` +
        compared.join(', ');
}
