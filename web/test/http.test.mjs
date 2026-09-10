import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sameOriginRedirect } from '../lib/http.js';

test('same-origin redirects remain relative to the browser-facing host', () => {
  const response = sameOriginRedirect('/admin/account/password?error=1');
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/admin/account/password?error=1');
});

test('same-origin redirects reject absolute and scheme-relative targets', () => {
  assert.throws(() => sameOriginRedirect('https://example.com/admin'), /same-origin path/);
  assert.throws(() => sameOriginRedirect('//example.com/admin'), /same-origin path/);
  assert.throws(() => sameOriginRedirect('/\\example.com/admin'), /same-origin path/);
  assert.throws(() => sameOriginRedirect('/admin', 200), /Redirect status/);
});

test('API routes never build browser redirects from the reverse-proxy request URL', () => {
  const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../app/api');
  const pending = [apiRoot];
  const unsafeRoutes = [];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(target);
      if (!entry.isFile() || entry.name !== 'route.js') continue;
      const source = fs.readFileSync(target, 'utf8');
      if (/(?:NextResponse|Response)\s*\.\s*redirect\s*\(/.test(source)) {
        unsafeRoutes.push(path.relative(apiRoot, target));
      }
    }
  }
  assert.deepEqual(unsafeRoutes, []);
});
