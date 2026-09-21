import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCatalog } from '../src/catalog.mjs';
import { ConflictError } from '../src/errors.mjs';

function withCatalog(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'policy-catalog-'));
  const db = openCatalog(join(dir, 'catalog.db'));
  try { fn(db); } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
}

test('revision is globally monotonic across all write kinds', () => withCatalog(db => {
  assert.equal(db.revision(), 0);
  assert.equal(db.put('a', 'k', 1).revision, 1);
  assert.equal(db.put('a', 'k', 1).revision, 2, 'same-value put still allocates revision');
  assert.equal(db.put('b', 'k', 2).revision, 3);
  assert.equal(db.remove('a', 'k').revision, 4);
  assert.equal(db.applyBatch('c', [{ action: 'put', key: 'x', value: 1 }]).revision, 5);
  assert.equal(db.revision(), 5);
}));

test('expectedRevision match succeeds and advances revision', () => withCatalog(db => {
  db.put('t', 'k', 1);
  const { revision } = db.put('t', 'k', 2, { expectedRevision: 1 });
  assert.equal(revision, 2);
  assert.equal(db.get('t', 'k').value, 2);
}));

test('expectedRevision mismatch throws ConflictError without side effects', () => withCatalog(db => {
  db.put('t', 'k', 1);
  assert.throws(() => db.put('t', 'k', 2, { expectedRevision: 99 }), ConflictError);
  assert.throws(() => db.remove('t', 'k', { expectedRevision: 0 }), ConflictError);
  assert.equal(db.revision(), 1);
  assert.equal(db.get('t', 'k').value, 1);
  assert.equal(db.audit('t').length, 1);
}));

test('audit records tenant, key, action, value and expiresAt per write', () => withCatalog(db => {
  db.put('t', 'k', { v: 1 }, { expiresAt: 5000 });
  db.remove('t', 'k');
  const rows = db.audit('t');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1], { revision: 1, tenant: 't', key: 'k', action: 'put', value: { v: 1 }, expiresAt: 5000 });
  assert.deepEqual(rows[0], { revision: 2, tenant: 't', key: 'k', action: 'remove', value: null, expiresAt: null });
  assert.equal(db.audit('other').length, 0);
}));
