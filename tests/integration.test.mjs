import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCatalog } from '../src/catalog.mjs';
import { ClosedError, ConflictError, StorageError } from '../src/errors.mjs';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'policy-catalog-'));
  return { dir, file: join(dir, 'catalog.db') };
}

test('two connections share data and revision; conflict detected across connections', () => {
  const { dir, file } = setup();
  const a = openCatalog(file);
  const b = openCatalog(file);
  try {
    a.put('t', 'k', 'from-a');
    assert.equal(b.get('t', 'k').value, 'from-a');
    assert.equal(b.revision(), 1);
    b.put('t', 'k', 'from-b', { expectedRevision: 1 });
    assert.equal(a.revision(), 2);
    assert.throws(() => a.put('t', 'k', 'stale', { expectedRevision: 1 }), ConflictError);
    assert.equal(a.get('t', 'k').value, 'from-b');
  } finally {
    a.close(); b.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test('busy database surfaces StorageError with cause', () => {
  const { dir, file } = setup();
  const db = openCatalog(file);
  const locker = new DatabaseSync(file);
  try {
    locker.exec('BEGIN IMMEDIATE');
    assert.throws(() => db.put('t', 'k', 1), error => {
      assert.ok(error instanceof StorageError);
      assert.ok(error.cause, 'StorageError must carry the SQLite cause');
      return true;
    });
    locker.exec('ROLLBACK');
    assert.ok(db.put('t', 'k', 1), 'write succeeds once the lock is released');
  } finally {
    locker.close(); db.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test('all methods throw ClosedError after close and cannot reopen', () => {
  const { dir, file } = setup();
  const db = openCatalog(file);
  db.put('t', 'k', 1);
  db.close();
  db.close();
  for (const call of [
    () => db.put('t', 'k', 1), () => db.remove('t', 'k'), () => db.get('t', 'k'),
    () => db.list('t'), () => db.applyBatch('t', [{ action: 'put', key: 'k', value: 1 }]),
    () => db.purgeExpired(), () => db.audit('t'), () => db.revision(),
  ]) {
    assert.throws(call, ClosedError);
  }
  rmSync(dir, { recursive: true, force: true });
});

test('open failure surfaces StorageError with cause', () => {
  assert.throws(() => openCatalog(join(tmpdir(), 'no-such-dir-xyz', 'sub', 'c.db')), error => {
    assert.ok(error instanceof StorageError);
    assert.ok(error.cause);
    return true;
  });
});

test('E2E: data, revision and audit survive reopen', () => {
  const { dir, file } = setup();
  const first = openCatalog(file);
  first.put('acme', 'checkout', { enabled: true }, { expiresAt: Date.now() + 60000 });
  first.applyBatch('acme', [{ action: 'put', key: 'search', value: { tier: 2 } }]);
  first.close();
  const second = openCatalog(file);
  try {
    assert.equal(second.revision(), 2);
    assert.deepEqual(second.get('acme', 'checkout').value, { enabled: true });
    assert.deepEqual(second.list('acme').map(r => r.key), ['checkout', 'search']);
    assert.equal(second.audit('acme').length, 2);
  } finally {
    second.close(); rmSync(dir, { recursive: true, force: true });
  }
});
