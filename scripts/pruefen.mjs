#!/usr/bin/env node
/**
 * scripts/pruefen.mjs
 * ------------------------------------------------------------------
 * Prüft vor dem Veröffentlichen, ob die zusammengestellte Webseite
 * vollständig ist und starten kann. Findet es einen Fehler, bricht das
 * Veröffentlichen ab – dann bleibt die alte, funktionierende Version online.
 *
 *     node scripts/pruefen.mjs _site
 *
 * Geprüft wird:
 *  1. Jede Datei, die ein Skript lädt (import … from './x.js'), ist da.
 *  2. Jede Datei aus der App-Liste des Service Workers (APP_SHELL) ist da.
 *  3. Alle Skripte sind fehlerfrei lesbar (keine Tippfehler im Code).
 *  4. Jedes Element, das app.js über seine ID sucht, steht in index.html.
 *  5. Die Daten-Dateien (data/*.json) sind gültiges JSON.
 * ------------------------------------------------------------------
 */

import { readFile, readdir, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const SITE = resolve(process.argv[2] || '_site');
const errors = [];
const exists = (p) => access(join(SITE, p)).then(() => true, () => false);

const jsFiles = (await readdir(SITE)).filter((f) => f.endsWith('.js'));

// 1. Importe
for (const file of jsFiles) {
  const src = await readFile(join(SITE, file), 'utf8');
  for (const [, dep] of src.matchAll(/from\s+'\.\/([^']+)'/g)) {
    if (!(await exists(dep))) errors.push(`${file} lädt ${dep}, die Datei fehlt`);
  }
}

// 2. App-Liste des Service Workers
const sw = await readFile(join(SITE, 'sw.js'), 'utf8');
const shell = sw.match(/APP_SHELL\s*=\s*\[([\s\S]*?)\]/)?.[1] || '';
for (const [, path] of shell.matchAll(/'\.\/([^']*)'/g)) {
  if (path && !(await exists(path))) errors.push(`sw.js braucht ${path}, die Datei fehlt`);
}

// 3. Code lesbar
for (const file of jsFiles) {
  try {
    const src = await readFile(join(SITE, file), 'utf8');
    execFileSync(process.execPath, ['--input-type=module', '--check'], { input: src, stdio: 'pipe' });
  } catch (err) {
    errors.push(`${file} enthält einen Fehler: ${String(err.stderr).split('\n').slice(0, 4).join(' ')}`);
  }
}

// 4. IDs
const html = await readFile(join(SITE, 'index.html'), 'utf8');
const app = await readFile(join(SITE, 'app.js'), 'utf8');
const ids = new Set([...app.matchAll(/(?:\$\('#|getElementById\(')([\w-]+)/g)].map((m) => m[1]));
for (const id of ids) {
  if (!html.includes(`id="${id}"`) && !app.includes(`id="${id}"`)) errors.push(`app.js sucht #${id}, das steht nicht in index.html`);
}

// 5. Daten
for (const file of (await readdir(join(SITE, 'data')).catch(() => [])).filter((f) => f.endsWith('.json'))) {
  try {
    JSON.parse(await readFile(join(SITE, 'data', file), 'utf8'));
  } catch (err) {
    errors.push(`data/${file} ist kaputt: ${err.message}`);
  }
}

if (errors.length) {
  errors.forEach((e) => console.log(`::error::${e}`));
  process.exit(1);
}
console.log(`✓ Webseite vollständig (${jsFiles.length} Skripte, ${ids.size} Elemente geprüft)`);
