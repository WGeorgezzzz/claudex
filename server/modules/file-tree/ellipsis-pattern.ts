/**
 * Assistant messages often abbreviate a long filename with an ellipsis
 * (`02-left-…-clutter10.mp4`). These helpers turn such a basename into the
 * literal pieces that must appear, in order, in the real filename.
 */

const ELLIPSIS = /…|\.{3,}/;

/** Returns the literal pieces around each ellipsis, or null when the basename is not abbreviated. */
export function splitEllipsisPattern(basename: string): string[] | null {
  if (!ELLIPSIS.test(basename) || /^\.+$/.test(basename) || /[\\/]/.test(basename)) return null;
  const parts = basename.split(new RegExp(ELLIPSIS.source, 'g'));
  // A bare "…" would match everything in the directory.
  if (parts.join('').length < 3) return null;
  return parts;
}

/** True when `name` starts with the first piece, ends with the last and contains the middle pieces in order. */
export function matchesEllipsisPattern(name: string, parts: string[]): boolean {
  const first = parts[0];
  const last = parts[parts.length - 1];
  if (name.length < first.length + last.length || !name.startsWith(first) || !name.endsWith(last)) return false;
  let cursor = first.length;
  const end = name.length - last.length;
  for (const middle of parts.slice(1, -1)) {
    const found = name.indexOf(middle, cursor);
    if (found < 0 || found + middle.length > end) return false;
    cursor = found + middle.length;
  }
  return cursor <= end;
}
