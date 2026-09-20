import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCatalog } from '../src/catalog.mjs';

test('legacy put/get/list behavior', () => {
  const dir = mkdtempSync(join(tmpdir(), 'policy-catalog-'));
  const db = openCatalog(join(dir, 'catalog.db'));
  db.put('acme', 'feature.search', { enabled: true });
  db.put('acme', 'feature.billing', { enabled: false });
  assert.deepEqual(db.get('acme', 'feature.search').value, { enabled: true });
  assert.deepEqual(db.list('acme').map(row => row.key), ['feature.billing', 'feature.search']);
  db.close(); rmSync(dir, { recursive: true, force: true });
});
