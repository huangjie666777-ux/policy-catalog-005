import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCatalog, ConflictError } from './src/catalog.mjs';

const dir = mkdtempSync(join(tmpdir(), 'policy-demo-'));
const dbPath = join(dir, 'catalog.db');

try {
  let now = 1_000;
  const db = openCatalog(dbPath, { now: () => now });

  console.log('== successful commit ==');
  const first = db.put('acme', 'checkout', { enabled: true, rollout: 25 }, { expiresAt: 5_000 });
  console.log('revision:', first.revision);
  const batch = db.applyBatch('acme', [
    { action: 'put', key: 'search', value: { enabled: true } },
    { action: 'put', key: 'billing', value: { enabled: false } },
    { action: 'put', key: 'billing', value: { enabled: true, rollout: 50 } },
  ]);
  console.log('batch revisions:', batch.revisions.join(','), 'final revision:', db.revision());
  console.log('keys:', db.list('acme').map(row => row.key).join(','));

  console.log('\n== optimistic revision conflict rolls back ==');
  try {
    db.put('acme', 'checkout', { enabled: false }, { expectedRevision: 1 });
  } catch (error) {
    console.log(error.name + ':', error.message);
  }
  console.log('value after conflict:', JSON.stringify(db.get('acme', 'checkout', { at: 1_000 }).value));
  console.log('revision after conflict:', db.revision());

  console.log('\n== expiry read semantics (expiresAt <= now hides a row) ==');
  console.log('at 4999:', JSON.stringify(db.get('acme', 'checkout', { at: 4_999 })));
  console.log('at 5000:', db.get('acme', 'checkout', { at: 5_000 }));
  now = 6_000;
  const purged = db.purgeExpired();
  console.log('purged at 6000:', purged.count, 'row(s); revision now', db.revision());

  console.log('\n== audit trail ==');
  for (const entry of db.audit('acme')) {
    console.log(`rev=${entry.revision} ${entry.action.padEnd(6)} ${entry.key} expiresAt=${entry.expiresAt} value=${entry.value === null ? 'null' : JSON.stringify(entry.value)}`);
  }

  db.close();
} finally {
  rmSync(dir, { recursive: true, force: true });
}
