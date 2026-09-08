import test from 'node:test';
import assert from 'node:assert/strict';
import { publicId } from '../lib/ids.js';
import { encodeCursor, parseCursor, searchTerm } from '../lib/pagination.js';

test('public IDs contain 128 random bits', () => {
  const values = new Set(Array.from({ length: 1000 }, () => publicId('ANJ-TEST')));
  assert.equal(values.size, 1000);
  assert.match([...values][0], /^ANJ-TEST-\d{6}-[A-F0-9]{32}$/);
});

test('cursor pagination validates and round trips', () => {
  const row = { id: '6c983b5e-47f9-4f45-9a33-0cff55a70c63', created_at: '2026-09-08T12:00:00.000Z' };
  assert.deepEqual(parseCursor(encodeCursor(row)), { timestamp: row.created_at, id: row.id });
  assert.equal(parseCursor('invalid'), null);
  assert.equal(searchTerm(`  ${'x'.repeat(100)}  `).length, 80);
});
