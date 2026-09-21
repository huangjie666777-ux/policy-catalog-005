import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCatalog } from '../src/catalog.mjs';
import { ValidationError } from '../src/errors.mjs';

function withCatalog(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'policy-catalog-'));
  const db = openCatalog(join(dir, 'catalog.db'));
  try { fn(db); } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
}

test('tenant and key must be non-empty strings', () => withCatalog(db => {
  for (const [tenant, key] of [['', 'k'], ['t', ''], [1, 'k'], ['t', null], [undefined, 'k']]) {
    assert.throws(() => db.put(tenant, key, {}), ValidationError);
    assert.throws(() => db.get(tenant, key), ValidationError);
    assert.throws(() => db.remove(tenant, key), ValidationError);
  }
  assert.throws(() => db.list(''), ValidationError);
  assert.throws(() => db.applyBatch('t', [{ action: 'put', key: '', value: 1 }]), ValidationError);
}));

test('value rejects non-JSON-serializable content', () => withCatalog(db => {
  const bad = [undefined, () => {}, 1n, NaN, Infinity, -Infinity, Symbol('s'),
    { nested: { fn: () => {} } }, [1, [NaN]], { big: 10n }];
  for (const value of bad) assert.throws(() => db.put('t', 'k', value), ValidationError, String(value));
  const circular = {}; circular.self = circular;
  assert.throws(() => db.put('t', 'k', circular), ValidationError);
  assert.equal(db.revision(), 0, 'failed validation must not allocate revision');
}));

test('expiresAt must be null or non-negative integer ms', () => withCatalog(db => {
  for (const expiresAt of [-1, 1.5, '100', NaN, Infinity]) {
    assert.throws(() => db.put('t', 'k', 1, { expiresAt }), ValidationError);
  }
  assert.ok(db.put('t', 'k', 1, { expiresAt: 0 }));
  assert.ok(db.put('t', 'k', 1, { expiresAt: null }));
  assert.ok(db.put('t', 'k', 1, { expiresAt: Date.now() + 1000 }));
}));

test('inputs and results do not share mutable references', () => withCatalog(db => {
  const input = { flags: ['a'], meta: { n: 1 } };
  db.put('t', 'k', input);
  input.flags.push('b');
  input.meta.n = 2;
  assert.deepEqual(db.get('t', 'k').value, { flags: ['a'], meta: { n: 1 } });
  const got = db.get('t', 'k');
  got.value.flags.push('x');
  assert.deepEqual(db.get('t', 'k').value.flags, ['a']);
  const listed = db.list('t');
  listed[0].value.meta.n = 99;
  assert.equal(db.get('t', 'k').value.meta.n, 1);
  const auditRows = db.audit('t');
  auditRows[0].value.meta.n = 42;
  assert.equal(db.audit('t')[0].value.meta.n, 1);
}));
