// Copies src/cameraSwitch.js into the single-file preview, between marker comments, as a
// classic-script IIFE (the preview has no bundler or modules). Run after editing the module:
//   node scripts/inline-into-preview.mjs
// src/preview-sync.test.js fails if the preview's copy has drifted from the module.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MODULE = path.join(HERE, '../src/cameraSwitch.js');
export const PREVIEW = path.join(HERE, '../../salvage/marbleverse-preview.html');
export const START = '/* ---- camera switching: generated from camera-switch/src/cameraSwitch.js by scripts/inline-into-preview.mjs; do not edit here ---- */';
export const END = '/* ---- end camera switching ---- */';

export function inlined(moduleSource) {
  const body = moduleSource.replace(/^export /gm, '').trimEnd();
  return `${START}\nconst KMCamera = (() => {\n${body}\nreturn { createCameraSwitcher, shouldMirror };\n})();\n${END}`;
}

export function currentBlock(html) {
  const a = html.indexOf(START); const b = html.indexOf(END);
  return a === -1 || b === -1 ? null : html.slice(a, b + END.length);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const html = fs.readFileSync(PREVIEW, 'utf8');
  const block = inlined(fs.readFileSync(MODULE, 'utf8'));
  const existing = currentBlock(html);
  if (!existing) throw new Error(`markers not found in ${PREVIEW}; add "${START}" and "${END}" where the code belongs`);
  fs.writeFileSync(PREVIEW, html.replace(existing, () => block));
  console.log('preview updated');
}
