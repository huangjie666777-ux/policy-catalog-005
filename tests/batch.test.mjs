import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCatalog } from '../src/catalog.mjs';
import { ConflictError, ValidationError } from '../src/errors.mjs';

function withCatalog(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'policy-catalog-'));
  const db = openCatalog(join(dir, 'catalog.db'));
  try { fn(db); } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
}

test('batch applies operations in order; duplicate keys last-write-wins', () => withCatalog(db => {
  const { revision } = db.applyBatch('t', [
    { action: 'put', key: 'k', value: 1 },
    { action: 'put', key: 'k', value: 2 },
    { action: 'remove', key: 'k' },
    { action: 'put', key: 'k', value: 3 },
  ]);
  assert.equal(db.get('t', 'k').value, 3);
  assert.equal(db.get('t', 'k').revision, revision);
  const audit = db.audit('t');
  assert.equal(audit.length, 4);
  assert.ok(audit.every(r => r.revision === revision), 'batch data and audit share one revision');
  assert.deepEqual(audit.map(r => r.action).reverse(), ['put', 'put', 'remove', 'put']);
}));

test('batch validates fully before writing; invalid op leaves no trace', () => withCatalog(db => {
  db.put('t', 'existing', 'keep');
  const before = db.revision();
  assert.throws(() => db.applyBatch('t', [
    { action: 'put', key: 'a', value: 1 },
    { action: 'put', key: 'b', value: NaN },
  ]), ValidationError);
  assert.throws(() => db.applyBatch('t', [{ action: 'drop', key: 'a' }]), ValidationError);
  assert.throws(() => db.applyBatch('t', []), ValidationError);
  assert.throws(() => db.applyBatch('t', 'nope'), ValidationError);
  assert.equal(db.revision(), before);
  assert.equal(db.get('t', 'a'), undefined);
  assert.equal(db.audit('t').length, 1, 'only the initial put is audited');
}));

test('batch expectedRevision conflict rolls back data, revision and audit', () => withCatalog(db => {
  db.put('t', 'x', 1);
  const before = db.revision();
  assert.throws(() => db.applyBatch('t', [
    { action: 'put', key: 'y', value: 2 },
    { action: 'remove', key: 'x' },
  ], { expectedRevision: before + 5 }), ConflictError);
  assert.equal(db.revision(), before);
  assert.equal(db.get('t', 'x').value, 1);
  assert.equal(db.get('t', 'y'), undefined);
  assert.equal(db.audit('t').length, 1);
}));

test('remove of a missing key still allocates revision and audit', () => withCatalog(db => {
  const { revision } = db.remove('t', 'ghost');
  assert.equal(revision, 1);
  assert.equal(db.audit('t')[0].action, 'remove');
}));
