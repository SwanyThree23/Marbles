// The production Content-Security-Policy (nginx) allows exactly one inline script: the
// "no flash" theme script in index.html, by its hash. Editing that script without updating
// the hash would block it in production, so this keeps the two in step.
import { test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const nginx = fs.readFileSync(path.join(root, '../kims-marbles-backend/deploy/nginx/kims-marbles-app.conf'), 'utf8');

test('every inline script in index.html is allowed by its sha256 in the nginx CSP, and nothing else is', () => {
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => `'sha256-${crypto.createHash('sha256').update(m[1]).digest('base64')}'`);
  expect(inline).toHaveLength(1);
  const csp = nginx.match(/Content-Security-Policy "([^"]+)"/)[1];
  const scriptSrc = csp.match(/script-src ([^;]+)/)[1].trim().split(/\s+/);
  expect(scriptSrc).toEqual(["'self'", ...inline]);
  expect(csp).not.toMatch(/unsafe-eval|script-src[^;]*unsafe-inline/);
});
