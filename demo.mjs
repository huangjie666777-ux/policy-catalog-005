import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCatalog } from './src/catalog.mjs';

const dir = mkdtempSync(join(tmpdir(), 'policy-demo-'));
const db = openCatalog(join(dir, 'catalog.db'));

// 1. Successful commit
const put = db.put('acme', 'checkout', { enabled: true }, { expiresAt: Date.now() + 60000 });
console.log('commit ok, revision:', put.revision);
console.log('get:', JSON.stringify(db.get('acme', 'checkout')));

// 2. Conflict rolls back without side effects
try {
  db.applyBatch('acme', [
    { action: 'put', key: 'search', value: { tier: 2 } },
    { action: 'remove', key: 'checkout' },
  ], { expectedRevision: 999 });
} catch (error) {
  console.log('conflict:', error.name, '-', error.message);
}
console.log('after rollback, revision:', db.revision(), 'checkout still:', db.get('acme', 'checkout') !== undefined);

// 3. Expired reads are filtered by the read clock
db.put('acme', 'trial', { days: 14 }, { expiresAt: Date.now() - 1 });
console.log('expired get:', db.get('acme', 'trial'));
const purged = db.purgeExpired();
console.log('purgeExpired:', JSON.stringify(purged));

// 4. Audit trail
console.log('audit:', JSON.stringify(db.audit('acme'), null, 2));

db.close();
rmSync(dir, { recursive: true, force: true });
