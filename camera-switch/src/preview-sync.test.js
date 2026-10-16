// The single-file preview carries its own copy of cameraSwitch.js. It must be the module,
// byte for byte (minus `export`), so the unit tests here also cover the preview's code.
import { test, expect } from 'vitest';
import fs from 'node:fs';
import { MODULE, PREVIEW, inlined, currentBlock } from '../scripts/inline-into-preview.mjs';

test('the preview contains exactly the current cameraSwitch.js (run scripts/inline-into-preview.mjs after editing)', () => {
  const block = currentBlock(fs.readFileSync(PREVIEW, 'utf8'));
  expect(block, 'camera-switch markers are missing from the preview').not.toBeNull();
  expect(block).toBe(inlined(fs.readFileSync(MODULE, 'utf8')));
});
