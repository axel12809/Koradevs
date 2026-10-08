import fs from 'node:fs';
import path from 'node:path';
import { createTwoFilesPatch, diffLines } from 'diff';
import { maskSecrets } from '@sos/shared';

const PLACEHOLDER = '[MASQUÉ:';

/** Splits text into lines that keep their trailing newline. */
function lines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

export interface Restored {
  text: string;
  /** Lines the helper wrote around a masked secret that cannot be matched to a real value. */
  unresolved: number;
}

/**
 * The helper edits the masked copy of a file. Applies their changes to the real file: untouched
 * lines keep their real content (and secrets), and an edited line that still holds a placeholder
 * gets its real value back when it matches a masked line of the original. `[MASQUÉ:…]` never
 * reaches the disk: lines that cannot be restored are counted in `unresolved`.
 */
export function restoreSecrets(original: string, proposed: string): Restored {
  const masked = maskSecrets(original).text;
  const realLines = lines(original);
  const maskedLines = lines(masked);
  if (realLines.length !== maskedLines.length) return { text: proposed, unresolved: proposed.includes(PLACEHOLDER) ? 1 : 0 };

  const known = new Map<string, string>();
  maskedLines.forEach((line, i) => {
    if (line.includes(PLACEHOLDER)) known.set(line.replace(/\n$/, ''), realLines[i]!.replace(/\n$/, ''));
  });

  let index = 0;
  let unresolved = 0;
  let text = '';
  for (const part of diffLines(masked, proposed)) {
    const count = lines(part.value).length;
    if (part.removed) {
      index += count;
    } else if (!part.added) {
      text += realLines.slice(index, index + count).join('');
      index += count;
    } else {
      for (const line of lines(part.value)) {
        if (!line.includes(PLACEHOLDER)) {
          text += line;
          continue;
        }
        const newline = line.endsWith('\n') ? '\n' : '';
        const real = known.get(line.slice(0, line.length - newline.length));
        if (real === undefined) unresolved += 1;
        text += (real ?? line.slice(0, line.length - newline.length)) + newline;
      }
    }
  }
  return { text, unresolved };
}

export type Correction =
  | { kind: 'identique' }
  | { kind: 'refusee'; reason: string }
  | { kind: 'prete'; file: string; text: string; diff: string };

/**
 * Checks and prepares a correction for one shared file. Only files that were shared in the
 * request can be written, and only inside the project root (no `..`, no symlink escape).
 * Nothing is written here: the caller asks the requester first.
 */
export function prepareCorrection(root: string, shared: string[], relPath: string, proposed: string): Correction {
  if (!shared.includes(relPath)) return { kind: 'refusee', reason: 'fichier non partagé' };
  const realRoot = fs.realpathSync(root);
  const file = path.resolve(realRoot, relPath);
  if (path.relative(realRoot, file).startsWith('..') || path.isAbsolute(path.relative(realRoot, file))) {
    return { kind: 'refusee', reason: 'chemin hors du projet' };
  }
  let original: string;
  try {
    if (path.relative(realRoot, fs.realpathSync(file)).startsWith('..')) return { kind: 'refusee', reason: 'chemin hors du projet' };
    original = fs.readFileSync(file, 'utf8');
  } catch {
    return { kind: 'refusee', reason: 'fichier introuvable' };
  }
  const masked = maskSecrets(original).text;
  if (masked === proposed) return { kind: 'identique' };
  const restored = restoreSecrets(original, proposed);
  if (restored.unresolved > 0) return { kind: 'refusee', reason: 'une ligne modifiée contient un secret masqué' };
  // The diff shown on screen uses the masked version, like the one the helper sees.
  const diff = createTwoFilesPatch(`a/${relPath}`, `b/${relPath}`, masked, proposed, '', '', { context: 3 });
  return { kind: 'prete', file, text: restored.text, diff };
}

export function writeCorrection(correction: Extract<Correction, { kind: 'prete' }>): void {
  fs.writeFileSync(correction.file, correction.text);
}
