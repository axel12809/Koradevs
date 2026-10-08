import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { maskSecrets } from '@sos/shared';
import { prepareCorrection, restoreSecrets, writeCorrection } from '../src/patch.js';

const SECRET = 'ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
const ORIGINAL = `const token = "${SECRET}";\nexport const greet = (user) =>\n  \`Bonjour \${user.name.toUpperCase()} !\`;\n`;

describe('restoreSecrets', () => {
  it('keeps real secrets on untouched lines', () => {
    const masked = maskSecrets(ORIGINAL).text;
    expect(masked).not.toContain(SECRET);
    const proposed = masked.replace('user.name', 'user?.name ?? "invité"');
    const restored = restoreSecrets(ORIGINAL, proposed);
    expect(restored).toEqual({ text: ORIGINAL.replace('user.name', 'user?.name ?? "invité"'), unresolved: 0 });
  });

  it('restores a moved masked line and flags an edited one', () => {
    const masked = maskSecrets(ORIGINAL).text;
    const [secretLine, ...rest] = masked.split('\n');
    const moved = restoreSecrets(ORIGINAL, [...rest.slice(0, 2), secretLine, ''].join('\n'));
    expect(moved.unresolved).toBe(0);
    expect(moved.text).toContain(SECRET);
    expect(moved.text).not.toContain('[MASQUÉ:');

    const edited = restoreSecrets(ORIGINAL, masked.replace('const token', 'let token'));
    expect(edited.unresolved).toBe(1);
  });
});

describe('prepareCorrection', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sos-patch-'));
    fs.writeFileSync(path.join(root, 'users.js'), ORIGINAL);
    fs.writeFileSync(path.join(root, 'other.js'), 'x\n');
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('prepares a diff without writing, then writes the restored file', () => {
    const proposed = maskSecrets(ORIGINAL).text.replace('user.name', 'user?.name');
    const c = prepareCorrection(root, ['users.js'], 'users.js', proposed);
    expect(c.kind).toBe('prete');
    if (c.kind !== 'prete') return;
    expect(c.diff).toContain('+  `Bonjour ${user?.name.toUpperCase()} !`;');
    expect(c.diff).not.toContain(SECRET);
    expect(fs.readFileSync(path.join(root, 'users.js'), 'utf8')).toBe(ORIGINAL);
    writeCorrection(c);
    expect(fs.readFileSync(path.join(root, 'users.js'), 'utf8')).toBe(ORIGINAL.replace('user.name', 'user?.name'));
  });

  it('ignores unchanged files', () => {
    expect(prepareCorrection(root, ['users.js'], 'users.js', maskSecrets(ORIGINAL).text)).toEqual({ kind: 'identique' });
  });

  it('refuses files that were not shared or are outside the project', () => {
    expect(prepareCorrection(root, ['users.js'], 'other.js', 'y\n')).toMatchObject({ kind: 'refusee', reason: 'fichier non partagé' });
    expect(prepareCorrection(root, ['../evil.js'], '../evil.js', 'y\n')).toMatchObject({ kind: 'refusee', reason: 'chemin hors du projet' });
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sos-out-'));
    fs.writeFileSync(path.join(outside, 'target.js'), 'a\n');
    fs.symlinkSync(path.join(outside, 'target.js'), path.join(root, 'link.js'));
    expect(prepareCorrection(root, ['link.js'], 'link.js', 'b\n')).toMatchObject({ kind: 'refusee', reason: 'chemin hors du projet' });
    fs.rmSync(outside, { recursive: true, force: true });
  });
});
