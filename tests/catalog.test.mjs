import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCatalog, Catalog, ClosedError, ConflictError, StorageError, ValidationError } from '../src/catalog.mjs';

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), 'policy-catalog-'));
}

function openTemp(options) {
  const dir = makeTempDir();
  const db = openCatalog(join(dir, 'catalog.db'), options);
  return { dir, db, done() { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('exports and basic put/get/list ordering', () => {
  assert.equal(typeof openCatalog, 'function');
  assert.equal(typeof Catalog, 'function');
  const { db, done } = openTemp();
  db.put('acme', 'zeta', { n: 1 });
  db.put('acme', 'alpha', { n: 2 });
  db.put('acme', 'mid', { n: 3 });
  db.put('other', 'alpha', { n: 4 });
  assert.deepEqual(db.list('acme').map(r => r.key), ['alpha', 'mid', 'zeta']);
  assert.equal(db.list('other').length, 1);
  assert.deepEqual(db.get('acme', 'mid').value, { n: 3 });
  assert.equal(db.get('acme', 'missing'), undefined);
  assert.equal(db.get('missing', 'mid'), undefined);
  done();
});

test('dictionary ordering uses binary key collation', () => {
  const { db, done } = openTemp();
  const keys = ['b', 'a', 'A', 'Z', '_', '0', 'aa'];
  keys.forEach((key, i) => db.put('t', key, i));
  assert.deepEqual(db.list('t').map(r => r.key), [...keys].sort());
  done();
});

test('prefix filters escape LIKE wildcards', () => {
  const { db, done } = openTemp();
  db.put('t', 'a.b', 1);
  db.put('t', 'a_b', 2);
  db.put('t', 'a%b', 3);
  db.put('t', 'axb', 4);
  db.put('t', 'other', 5);
  assert.deepEqual(db.list('t', { prefix: 'a.' }).map(r => r.key), ['a.b']);
  assert.deepEqual(db.list('t', { prefix: 'a_' }).map(r => r.key), ['a_b']);
  assert.deepEqual(db.list('t', { prefix: 'a%' }).map(r => r.key), ['a%b']);
  assert.deepEqual(db.list('t', { prefix: 'a' }).map(r => r.key), ['a%b', 'a.b', 'a_b', 'axb']);
  done();
});

test('input and returned values never share mutable references', () => {
  const { db, done } = openTemp();
  const value = { nested: { flag: true }, list: [1, 2] };
  db.put('t', 'k', value);
  value.nested.flag = false;
  value.list.push(3);
  const first = db.get('t', 'k');
  assert.equal(first.value.nested.flag, true);
  first.value.nested.flag = 'mutated';
  first.value.list.push(99);
  const second = db.get('t', 'k');
  assert.equal(second.value.nested.flag, true);
  assert.deepEqual(second.value.list, [1, 2]);
  const listed = db.list('t')[0];
  listed.value.nested.flag = 'mutated';
  assert.equal(db.get('t', 'k').value.nested.flag, true);
  done();
});

test('null and primitive JSON values round-trip', () => {
  const { db, done } = openTemp();
  db.put('t', 'null', null);
  db.put('t', 'str', 'hello');
  db.put('t', 'num', 42);
  db.put('t', 'bool', false);
  db.put('t', 'arr', [null, true, 'x']);
  assert.equal(db.get('t', 'null').value, null);
  assert.equal(db.get('t', 'str').value, 'hello');
  assert.equal(db.get('t', 'num').value, 42);
  assert.equal(db.get('t', 'bool').value, false);
  assert.deepEqual(db.get('t', 'arr').value, [null, true, 'x']);
  done();
});

test('invalid tenant/key rejected', () => {
  const { db, done } = openTemp();
  for (const bad of ['', 0, 1, null, undefined, {}, [], true]) {
    assert.throws(() => db.put(bad, 'k', 1), ValidationError);
    assert.throws(() => db.put('t', bad, 1), ValidationError);
    assert.throws(() => db.get(bad, 'k'), ValidationError);
    assert.throws(() => db.remove('t', bad), ValidationError);
  }
  done();
});

test('non-JSON values rejected without side effects', () => {
  const { db, done } = openTemp();
  const before = db.revision();
  const circular = {};
  circular.self = circular;
  for (const bad of [undefined, () => 1, 1n, NaN, Infinity, -Infinity, { x: undefined }, [NaN], circular]) {
    assert.throws(() => db.put('t', 'k', bad), ValidationError);
  }
  assert.equal(db.revision(), before);
  assert.equal(db.get('t', 'k'), undefined);
  assert.throws(() => db.applyBatch('t', [{ action: 'put', key: 'a', value: 1n }]), ValidationError);
  assert.equal(db.revision(), before);
  done();
});

test('expiresAt validation', () => {
  const { db, done } = openTemp();
  for (const bad of [-1, 1.5, '10', NaN, Infinity]) {
    assert.throws(() => db.put('t', 'k', 1, { expiresAt: bad }), ValidationError);
  }
  db.put('t', 'zero', 1, { expiresAt: 0 });
  db.put('t', 'big', 2, { expiresAt: Number.MAX_SAFE_INTEGER });
  done();
});

test('TTL boundary visibility', () => {
  let clock = 1000;
  const { db, done } = openTemp({ now: () => clock });
  db.put('t', 'expires1000', 1, { expiresAt: 1000 });
  db.put('t', 'expires1001', 2, { expiresAt: 1001 });
  db.put('t', 'forever', 3);
  assert.equal(db.get('t', 'expires1000', { at: 999 }).value, 1);
  assert.equal(db.get('t', 'expires1000', { at: 1000 }), undefined);
  assert.equal(db.get('t', 'expires1001', { at: 1000 }).value, 2);
  assert.deepEqual(db.list('t', { at: 1000 }).map(r => r.key), ['expires1001', 'forever']);
  clock = 1001;
  assert.deepEqual(db.list('t').map(r => r.key), ['forever']);
  assert.equal(db.get('t', 'forever').expiresAt, null);
  assert.throws(() => db.get('t', 'forever', { at: -1 }), ValidationError);
  done();
});

test('every successful write advances global revision', () => {
  const { db, done } = openTemp();
  assert.equal(db.revision(), 0);
  const r1 = db.put('t', 'a', 1).revision;
  const r2 = db.put('t', 'a', 1).revision;
  const r3 = db.remove('t', 'missing').revision;
  const r4 = db.remove('t', 'a').revision;
  assert.deepEqual([r1, r2, r3, r4], [1, 2, 3, 4]);
  assert.equal(db.revision(), 4);
  assert.equal(db.get('t', 'a'), undefined);
  db.put('t', 'a', 1);
  db.put('t', 'a', 2);
  assert.equal(db.get('t', 'a').revision, 6);
  done();
});

test('expectedRevision conflict has no side effects', () => {
  const { db, done } = openTemp();
  db.put('t', 'a', 1);
  assert.throws(() => db.put('t', 'b', 2, { expectedRevision: 99 }), ConflictError);
  assert.throws(() => db.remove('t', 'a', { expectedRevision: 99 }), ConflictError);
  assert.throws(() => db.put('t', 'a', 2, { expectedRevision: -1 }), ValidationError);
  assert.equal(db.revision(), 1);
  assert.equal(db.get('t', 'b'), undefined);
  assert.equal(db.get('t', 'a').value, 1);
  assert.equal(db.put('t', 'b', 2, { expectedRevision: 1 }).revision, 2);
  done();
});

test('applyBatch validates fully before any write', () => {
  const { db, done } = openTemp();
  db.put('t', 'seed', 0);
  const before = db.revision();
  assert.throws(() => db.applyBatch('t', [
    { action: 'put', key: 'a', value: 1 },
    { action: 'bogus', key: 'b' },
  ]), ValidationError);
  assert.throws(() => db.applyBatch('t', [{ action: 'put', key: 'a', value: { x: NaN } }]), ValidationError);
  assert.throws(() => db.applyBatch('t', []), ValidationError);
  assert.throws(() => db.applyBatch('t', 'notarray'), ValidationError);
  assert.throws(() => db.applyBatch('t', [{ action: 'remove', key: '' }]), ValidationError);
  assert.throws(() => db.applyBatch('t', [{ action: 'put', key: 'a', value: 1, expiresAt: false }]), ValidationError);
  assert.equal(db.revision(), before);
  assert.equal(db.get('t', 'a'), undefined);
  done();
});

test('applyBatch runs in order and duplicate keys follow the last op', () => {
  const { db, done } = openTemp();
  const result = db.applyBatch('t', [
    { action: 'put', key: 'a', value: 1 },
    { action: 'put', key: 'a', value: 2 },
    { action: 'put', key: 'b', value: 3 },
    { action: 'remove', key: 'b' },
    { action: 'put', key: 'a', value: 4, expiresAt: 100 },
  ]);
  assert.deepEqual(result.revisions, [1, 2, 3, 4, 5]);
  assert.equal(result.revision, 5);
  assert.equal(db.get('t', 'a', { at: 99 }).value, 4);
  assert.equal(db.get('t', 'a', { at: 99 }).expiresAt, 100);
  assert.equal(db.get('t', 'a', { at: 100 }), undefined);
  assert.equal(db.get('t', 'b'), undefined);
  assert.equal(db.revision(), 5);
  done();
});

test('applyBatch conflict rolls back data, revision and audit', () => {
  const { db, done } = openTemp();
  db.put('t', 'seed', 0);
  assert.throws(() => db.applyBatch('t', [
    { action: 'put', key: 'a', value: 1 },
    { action: 'remove', key: 'seed' },
  ], { expectedRevision: 5 }), ConflictError);
  assert.equal(db.revision(), 1);
  assert.equal(db.get('t', 'a'), undefined);
  assert.equal(db.get('t', 'seed').value, 0);
  assert.equal(db.audit('t').length, 1);
  done();
});

test('batch-level expectedRevision wins; per-op value ignored', () => {
  const { db, done } = openTemp();
  const result = db.applyBatch('t', [
    { action: 'put', key: 'a', value: 1, expectedRevision: 999 },
    { action: 'remove', key: 'nope', expectedRevision: 999 },
  ]);
  assert.equal(result.revision, 2);
  assert.equal(db.revision(), 2);
  done();
});

test('audit records actions in order with the matching revision', () => {
  const { db, done } = openTemp();
  db.put('t', 'a', { v: 1 });
  db.put('t', 'a', { v: 2 }, { expiresAt: 500 });
  db.remove('t', 'a');
  const entries = db.audit('t');
  assert.deepEqual(entries.map(e => [e.revision, e.action, e.key, e.tenant]), [
    [1, 'put', 'a', 't'],
    [2, 'put', 'a', 't'],
    [3, 'remove', 'a', 't'],
  ]);
  assert.deepEqual(entries[0].value, { v: 1 });
  assert.equal(entries[0].expiresAt, null);
  assert.equal(entries[1].expiresAt, 500);
  assert.equal(entries[2].value, null);
  assert.equal(entries[2].expiresAt, null);
  assert.equal(db.audit('t', { limit: 2 }).length, 2);
  assert.equal(db.audit('other').length, 0);
  assert.throws(() => db.audit('t', { limit: 0 }), ValidationError);
  done();
});

test('audit values are deep copies', () => {
  const { db, done } = openTemp();
  db.put('t', 'a', { n: 1 });
  const row = db.audit('t')[0];
  row.value.n = 999;
  assert.equal(db.audit('t')[0].value.n, 1);
  done();
});

test('batch audit shares revisions with data writes', () => {
  const { db, done } = openTemp();
  db.applyBatch('t', [
    { action: 'put', key: 'a', value: 1 },
    { action: 'remove', key: 'a' },
  ]);
  const entries = db.audit('t');
  assert.deepEqual(entries.map(e => [e.revision, e.action]), [[1, 'put'], [2, 'remove']]);
  done();
});

test('purgeExpired deletes only rows expired at call time and audits deletions', () => {
  const { db, done } = openTemp();
  db.put('t', 'old', 1, { expiresAt: 100 });
  db.put('u', 'old-other', 2, { expiresAt: 100 });
  db.put('t', 'soon', 3, { expiresAt: 101 });
  db.put('t', 'keep', 4);
  const nothing = db.purgeExpired({ at: 99 });
  assert.deepEqual(nothing, { count: 0, revision: 4 });
  assert.equal(db.revision(), 4);
  const result = db.purgeExpired({ at: 100 });
  assert.equal(result.count, 2);
  assert.equal(result.revision, 6);
  assert.equal(db.get('t', 'old'), undefined);
  assert.equal(db.get('u', 'old-other'), undefined);
  assert.equal(db.get('t', 'soon', { at: 100 }).value, 3);
  const second = db.purgeExpired({ at: 200 });
  assert.equal(second.count, 1);
  const purgeAudit = db.audit('t').filter(e => e.action === 'purge').map(e => [e.key, e.revision]);
  assert.deepEqual(purgeAudit, [['old', 5], ['soon', 7]]);
  assert.equal(db.audit('u').filter(e => e.action === 'purge').length, 1);
  const again = db.purgeExpired({ at: 300 });
  assert.equal(again.count, 0);
  assert.equal(again.revision, 7);
  done();
});

test('data persists across catalog connections', () => {
  const dir = makeTempDir();
  try {
    const first = openCatalog(join(dir, 'catalog.db'));
    first.put('t', 'a', { persisted: true });
    first.close();
    const second = openCatalog(join(dir, 'catalog.db'));
    assert.equal(second.revision(), 1);
    assert.deepEqual(second.get('t', 'a').value, { persisted: true });
    assert.equal(second.audit('t').length, 1);
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('two independent connections commit atomically with BEGIN IMMEDIATE', () => {
  const dir = makeTempDir();
  try {
    const a = openCatalog(join(dir, 'catalog.db'));
    const b = openCatalog(join(dir, 'catalog.db'));
    a.put('t', 'a', 1);
    b.put('t', 'b', 2);
    const seenByA = a.revision();
    const seenByB = b.revision();
    assert.equal(seenByA, 2);
    assert.equal(seenByB, 2);
    a.applyBatch('t', [{ action: 'put', key: 'c', value: 3 }, { action: 'put', key: 'd', value: 4 }]);
    assert.deepEqual(b.list('t').map(r => r.key), ['a', 'b', 'c', 'd']);
    assert.throws(() => b.put('t', 'e', 5, { expectedRevision: 2 }), ConflictError);
    assert.equal(b.put('t', 'e', 5, { expectedRevision: 4 }).revision, 5);
    const purged = b.purgeExpired();
    assert.equal(purged.count, 0);
    a.close();
    b.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('closed catalog rejects every method and cannot reopen', () => {
  const { db, dir } = openTemp();
  db.put('t', 'a', 1);
  db.close();
  assert.throws(() => db.put('t', 'a', 1), ClosedError);
  assert.throws(() => db.get('t', 'a'), ClosedError);
  assert.throws(() => db.list('t'), ClosedError);
  assert.throws(() => db.remove('t', 'a'), ClosedError);
  assert.throws(() => db.applyBatch('t', [{ action: 'remove', key: 'a' }]), ClosedError);
  assert.throws(() => db.purgeExpired(), ClosedError);
  assert.throws(() => db.audit('t'), ClosedError);
  assert.throws(() => db.revision(), ClosedError);
  assert.throws(() => db.close(), ClosedError);
  rmSync(dir, { recursive: true, force: true });
});

test('sqlite errors surface as StorageError with cause', () => {
  const dir = makeTempDir();
  try {
    assert.throws(
      () => openCatalog(join(dir, 'missing-dir', 'catalog.db')),
      err => err instanceof StorageError && err.cause !== undefined,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('StorageError wraps runtime sqlite failures with cause', () => {
  const { db, done } = openTemp();
  const wrapped = new StorageError('put failed', { cause: new Error('disk I/O error') });
  assert.equal(wrapped.name, 'StorageError');
  assert.equal(wrapped.cause.message, 'disk I/O error');
  assert.equal(typeof db.put, 'function');
  done();
});
