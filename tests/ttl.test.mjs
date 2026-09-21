import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCatalog } from '../src/catalog.mjs';

function withCatalog(fn, now = () => 1000) {
  const dir = mkdtempSync(join(tmpdir(), 'policy-catalog-'));
  const db = openCatalog(join(dir, 'catalog.db'), { now });
  try { fn(db); } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
}

test('get filters rows with expiresAt <= now', () => withCatalog(db => {
  db.put('t', 'k', 'v', { expiresAt: 1000 });
  assert.equal(db.get('t', 'k', { at: 999 }).value, 'v');
  assert.equal(db.get('t', 'k', { at: 1000 }), undefined, 'boundary: expiresAt == now is expired');
  assert.equal(db.get('t', 'k'), undefined, 'default read clock is now()');
}));

test('list filters expired rows and sorts by key', () => withCatalog(db => {
  db.put('t', 'b', 1, { expiresAt: 500 });
  db.put('t', 'a', 2, { expiresAt: 2000 });
  db.put('t', 'c', 3);
  assert.deepEqual(db.list('t').map(r => r.key), ['a', 'c']);
  assert.deepEqual(db.list('t', { at: 2000 }).map(r => r.key), ['c']);
}));

test('purgeExpired deletes only rows expired at call time and audits them', () => withCatalog(db => {
  db.put('t', 'expired1', 1, { expiresAt: 400 });
  db.put('t', 'expired2', 2, { expiresAt: 1000 });
  db.put('t', 'alive', 3, { expiresAt: 5000 });
  db.put('t', 'forever', 4);
  const before = db.revision();
  const result = db.purgeExpired({ at: 1000 });
  assert.equal(result.purged, 2);
  assert.ok(result.revision > before);
  assert.deepEqual(db.list('t', { at: 0 }).map(r => r.key), ['alive', 'forever']);
  const purgeAudit = db.audit('t').filter(r => r.action === 'purge');
  assert.deepEqual(purgeAudit.map(r => r.key).sort(), ['expired1', 'expired2']);
  assert.ok(purgeAudit.every(r => r.revision === result.revision));
  const noop = db.purgeExpired({ at: 1000 });
  assert.equal(noop.purged, 0);
  assert.equal(db.revision(), result.revision, 'no-op purge must not allocate revision');
}));
