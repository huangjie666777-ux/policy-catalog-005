import { DatabaseSync } from 'node:sqlite';
import { ClosedError, ConflictError, StorageError, ValidationError } from './errors.mjs';

const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const jsonValue = value => JSON.stringify(value);

export function openCatalog(filename, options = {}) {
  return new Catalog(filename, options);
}

export class Catalog {
  #db; #now; #closed = false;
  constructor(filename, { now = () => Date.now() } = {}) {
    this.#db = new DatabaseSync(filename);
    this.#now = now;
    this.#db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY CHECK (id=1), revision INTEGER NOT NULL);
      INSERT OR IGNORE INTO meta(id, revision) VALUES (1, 0);
      CREATE TABLE IF NOT EXISTS policies (
        tenant TEXT NOT NULL, key TEXT NOT NULL, value_json TEXT NOT NULL,
        revision INTEGER NOT NULL, expires_at INTEGER, PRIMARY KEY (tenant, key));
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, revision INTEGER NOT NULL,
        tenant TEXT NOT NULL, key TEXT NOT NULL, action TEXT NOT NULL, value_json TEXT,
        expires_at INTEGER);
    `);
  }
  #open() { if (this.#closed) throw new ClosedError('Catalog is closed'); return this.#db; }
  #checkText(value, label) { if (typeof value !== 'string' || value.length === 0) throw new ValidationError(`${label} must be a non-empty string`); }
  #encode(value) { try { const text = jsonValue(value); if (text === undefined || !Number.isFinite(JSON.parse(text))) return text; return text; } catch (cause) { throw new ValidationError('value must be JSON serializable', { cause }); } }
  revision() { this.#open(); return this.#db.prepare('SELECT revision FROM meta WHERE id=1').get().revision; }
  get(tenant, key, { at = this.#now() } = {}) {
    this.#open(); this.#checkText(tenant, 'tenant'); this.#checkText(key, 'key');
    const row = this.#db.prepare('SELECT value_json, revision, expires_at FROM policies WHERE tenant=? AND key=?').get(tenant, key);
    if (!row || (row.expires_at !== null && row.expires_at <= at)) return undefined;
    return { tenant, key, value: clone(JSON.parse(row.value_json)), revision: row.revision, expiresAt: row.expires_at };
  }
  list(tenant, { prefix = '', at = this.#now() } = {}) {
    this.#open(); this.#checkText(tenant, 'tenant');
    const rows = this.#db.prepare('SELECT tenant,key,value_json,revision,expires_at FROM policies WHERE tenant=? AND key LIKE ? ORDER BY key').all(tenant, `${prefix}%`);
    return rows.filter(row => row.expires_at === null || row.expires_at > at).map(row => ({ tenant, key: row.key, value: clone(JSON.parse(row.value_json)), revision: row.revision, expiresAt: row.expires_at }));
  }
  put(tenant, key, value, { expectedRevision, expiresAt = null } = {}) {
    this.#open(); this.#checkText(tenant, 'tenant'); this.#checkText(key, 'key'); const valueJson = this.#encode(value);
    try { this.#db.exec('BEGIN'); const revision = this.revision(); if (expectedRevision !== undefined && revision !== expectedRevision) throw new ConflictError('revision conflict');
      const next = revision + 1; this.#db.prepare('INSERT OR REPLACE INTO policies(tenant,key,value_json,revision,expires_at) VALUES(?,?,?,?,?)').run(tenant,key,valueJson,next,expiresAt);
      this.#db.prepare('UPDATE meta SET revision=? WHERE id=1').run(next); this.#db.exec('COMMIT'); return { revision: next };
    } catch (cause) { try { this.#db.exec('ROLLBACK'); } catch {} if (cause instanceof ConflictError) throw cause; throw new StorageError('put failed', { cause }); }
  }
  remove(tenant, key, options = {}) { this.#open(); this.#checkText(tenant, 'tenant'); this.#checkText(key, 'key'); return this.put(tenant, key, null, options); }
  applyBatch(tenant, operations, { expectedRevision } = {}) {
    this.#open(); this.#checkText(tenant, 'tenant'); if (!Array.isArray(operations) || operations.length === 0) throw new ValidationError('operations must be non-empty');
    for (const op of operations) { if (!op || !['put','remove'].includes(op.action)) throw new ValidationError('invalid operation'); this.#checkText(op.key, 'key'); }
    return operations.map(op => op.action === 'put' ? this.put(tenant, op.key, op.value, { expectedRevision, expiresAt: op.expiresAt ?? null }) : this.remove(tenant, op.key, { expectedRevision }));
  }
  purgeExpired({ at = this.#now() } = {}) { this.#open(); return this.list('_internal_', { at }).length; }
  audit(tenant, { limit = 100 } = {}) { this.#open(); this.#checkText(tenant, 'tenant'); return this.#db.prepare('SELECT revision,tenant,key,action,value_json,expires_at AS expiresAt FROM audit WHERE tenant=? ORDER BY id DESC LIMIT ?').all(tenant, limit); }
  close() { if (!this.#closed) { this.#db.close(); this.#closed = true; } }
}
