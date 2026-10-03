import * as path from 'path';

/** Sorted, newline-separated file list that fits in `maxChars`; `shown` is how many paths made it in. */
export function formatFileList(paths: string[], maxChars: number): { text: string; shown: number } {
  const sorted = [...paths].sort();
  const lines: string[] = [];
  let chars = 0;
  for (const p of sorted) {
    if (chars + p.length + 1 > maxChars) {
      break;
    }
    lines.push(p);
    chars += p.length + 1;
  }
  return { text: lines.join('\n'), shown: lines.length };
}

function isWithin(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Where a model-supplied file path could live in the workspace: one candidate per root for a relative path,
 * or the path itself if it is absolute and inside a root. Empty when it would escape every root.
 */
export function resolveInWorkspace(file: string, roots: string[]): string[] {
  const cleaned = file.trim().replace(/\\/g, '/');
  if (!cleaned) {
    return [];
  }
  if (path.isAbsolute(cleaned)) {
    const abs = path.normalize(cleaned);
    return roots.some((r) => isWithin(r, abs)) ? [abs] : [];
  }
  return roots.map((r) => path.resolve(r, cleaned)).filter((abs, i) => isWithin(roots[i], abs));
}
