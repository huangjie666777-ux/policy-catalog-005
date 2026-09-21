import { DatabaseSync } from 'node:sqlite';
import { ClosedError, ConflictError, StorageError, ValidationError } from './errors.mjs';

export function openCatalog(filename, options = {}) {
  return new Catalog(filename, options);
}

function assertJsonSerializable(value, path = 'value', seen = new Set()) {
  if (value === undefined) throw new ValidationError(`${path} must not be undefined`);
  const type = typeof value;
  if (type === 'function' || type === 'symbol' || type === 'bigint') {
    throw new ValidationError(`${path} must be JSON serializable, got ${type}`);
  }
  if (type === 'number' && !Number.isFinite(value)) {
    throw new ValidationError(`${path} must be a finite number`);
  }
  if (type !== 'object' || value === null) return;
  if (seen.has(value)) throw new ValidationError(`${path} must not contain circular references`);
  seen.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) assertJsonSerializable(value[i], `${path}[${i}]`, seen);
    return;
  }
  for (const [key, item] of Object.entries(value)) assertJsonSerializable(item, `${path}.${key}`, seen);
}

function encodeValue(value) {
  assertJsonSerializable(value);
  try {
    return JSON.stringify(value);
  } catch (cause) {
    throw new ValidationError('value must be JSON serializable', { cause });
  }
}

function checkExpiresAt(expiresAt) {
  if (expiresAt === null) return;
  if (typeof expiresAt !== 'number' || !Number.isInteger(expiresAt) || expiresAt < 0) {
    throw new ValidationError('expiresAt must be null or a non-negative integer (ms)');
  }
}

function checkText(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`${label} must be a non-empty string`);
  }
}

function checkAt(at) {
  if (typeof at !== 'number' || !Number.isFinite(at)) {
    throw new ValidationError('at must be a finite number (ms)');
  }
}

export class Catalog {
  #db;
  #now;
  #closed = false;

  constructor(filename, { now = () => Date.now() } = {}) {
    try {
      this.#db = new DatabaseSync(filename);
      this.#db.exec(`
        PRAGMA journal_mode=WAL;
        PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS meta (
          id INTEGER PRIMARY KEY CHECK (id=1),
          revision INTEGER NOT NULL
        );
        INSERT OR IGNORE INTO meta(id, revision) VALUES (1, 0);
        CREATE TABLE IF NOT EXISTS policies (
          tenant TEXT NOT NULL,
          key TEXT NOT NULL,
          value_json TEXT NOT NULL,
          revision INTEGER NOT NULL,
          expires_at INTEGER,
          PRIMARY KEY (tenant, key)
        );
        CREATE TABLE IF NOT EXISTS audit (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          revision INTEGER NOT NULL,
          tenant TEXT NOT NULL,
          key TEXT NOT NULL,
          action TEXT NOT NULL,
          value_json TEXT,
          expires_at INTEGER
        );
      `);
    } catch (cause) {
      throw new StorageError('failed to open catalog storage', { cause });
    }
    this.#now = typeof now === 'function' ? now : () => Date.now();
  }

  #open() {
    if (this.#closed) throw new ClosedError('Catalog is closed');
    return this.#db;
  }

  // Runs fn inside a BEGIN IMMEDIATE transaction. fn receives the next
  // revision after expectedRevision has been verified against meta.
  #write(expectedRevision, fn) {
    const db = this.#open();
    try {
      db.exec('BEGIN IMMEDIATE');
    } catch (cause) {
      throw new StorageError('failed to begin write transaction', { cause });
    }
    try {
      const current = db.prepare('SELECT revision FROM meta WHERE id=1').get().revision;
      if (expectedRevision !== undefined && expectedRevision !== current) {
        throw new ConflictError(`revision conflict: expected ${expectedRevision}, current ${current}`);
      }
      const next = current + 1;
      fn(next);
      db.prepare('UPDATE meta SET revision=? WHERE id=1').run(next);
      db.exec('COMMIT');
      return { revision: next };
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      if (error instanceof ConflictError || error instanceof ValidationError) throw error;
      throw new StorageError('write failed', { cause: error });
    }
  }

  revision() {
    const db = this.#open();
    try {
      return db.prepare('SELECT revision FROM meta WHERE id=1').get().revision;
    } catch (cause) {
      throw new StorageError('failed to read revision', { cause });
    }
  }

  get(tenant, key, { at = this.#now() } = {}) {
    const db = this.#open();
    checkText(tenant, 'tenant');
    checkText(key, 'key');
    checkAt(at);
    let row;
    try {
      row = db.prepare('SELECT value_json, revision, expires_at FROM policies WHERE tenant=? AND key=?').get(tenant, key);
    } catch (cause) {
      throw new StorageError('get failed', { cause });
    }
    if (!row || (row.expires_at !== null && row.expires_at <= at)) return undefined;
    return { tenant, key, value: JSON.parse(row.value_json), revision: row.revision, expiresAt: row.expires_at };
  }

  list(tenant, { prefix = '', at = this.#now() } = {}) {
    const db = this.#open();
    checkText(tenant, 'tenant');
    if (typeof prefix !== 'string') throw new ValidationError('prefix must be a string');
    checkAt(at);
    let rows;
    try {
      rows = db.prepare(
        "SELECT key, value_json, revision, expires_at FROM policies WHERE tenant=? AND key LIKE ? ESCAPE '\\' ORDER BY key"
      ).all(tenant, `${prefix.replace(/[\\%_]/g, ch => `\\${ch}`)}%`);
    } catch (cause) {
      throw new StorageError('list failed', { cause });
    }
    return rows
      .filter(row => row.expires_at === null || row.expires_at > at)
      .map(row => ({ tenant, key: row.key, value: JSON.parse(row.value_json), revision: row.revision, expiresAt: row.expires_at }));
  }

  put(tenant, key, value, { expectedRevision, expiresAt = null } = {}) {
    this.#open();
    checkText(tenant, 'tenant');
    checkText(key, 'key');
    const valueJson = encodeValue(value);
    checkExpiresAt(expiresAt);
    return this.#write(expectedRevision, revision => {
      this.#db.prepare(
        'INSERT OR REPLACE INTO policies(tenant,key,value_json,revision,expires_at) VALUES(?,?,?,?,?)'
      ).run(tenant, key, valueJson, revision, expiresAt);
      this.#insertAudit(revision, tenant, key, 'put', valueJson, expiresAt);
    });
  }

  remove(tenant, key, { expectedRevision } = {}) {
    this.#open();
    checkText(tenant, 'tenant');
    checkText(key, 'key');
    return this.#write(expectedRevision, revision => {
      this.#db.prepare('DELETE FROM policies WHERE tenant=? AND key=?').run(tenant, key);
      this.#insertAudit(revision, tenant, key, 'remove', null, null);
    });
  }

  applyBatch(tenant, operations, { expectedRevision } = {}) {
    this.#open();
    checkText(tenant, 'tenant');
    if (!Array.isArray(operations) || operations.length === 0) {
      throw new ValidationError('operations must be a non-empty array');
    }
    // Full validation pass before touching the database.
    const prepared = operations.map((op, index) => {
      if (!op || typeof op !== 'object') throw new ValidationError(`operation ${index} must be an object`);
      if (op.action !== 'put' && op.action !== 'remove') {
        throw new ValidationError(`operation ${index} has invalid action`);
      }
      checkText(op.key, `operation ${index} key`);
      if (op.action === 'put') {
        const expiresAt = op.expiresAt ?? null;
        checkExpiresAt(expiresAt);
        return { action: 'put', key: op.key, valueJson: encodeValue(op.value), expiresAt };
      }
      return { action: 'remove', key: op.key };
    });
    return this.#write(expectedRevision, revision => {
      for (const op of prepared) {
        if (op.action === 'put') {
          this.#db.prepare(
            'INSERT OR REPLACE INTO policies(tenant,key,value_json,revision,expires_at) VALUES(?,?,?,?,?)'
          ).run(tenant, op.key, op.valueJson, revision, op.expiresAt);
          this.#insertAudit(revision, tenant, op.key, 'put', op.valueJson, op.expiresAt);
        } else {
          this.#db.prepare('DELETE FROM policies WHERE tenant=? AND key=?').run(tenant, op.key);
          this.#insertAudit(revision, tenant, op.key, 'remove', null, null);
        }
      }
    });
  }

  purgeExpired({ at = this.#now() } = {}) {
    this.#open();
    checkAt(at);
    let expired;
    try {
      expired = this.#db.prepare(
        'SELECT tenant, key, expires_at FROM policies WHERE expires_at IS NOT NULL AND expires_at <= ?'
      ).all(at);
    } catch (cause) {
      throw new StorageError('purgeExpired scan failed', { cause });
    }
    if (expired.length === 0) return { purged: 0, revision: this.revision() };
    const { revision } = this.#write(undefined, next => {
      const del = this.#db.prepare('DELETE FROM policies WHERE tenant=? AND key=? AND expires_at IS NOT NULL AND expires_at <= ?');
      for (const row of expired) {
        const { changes } = del.run(row.tenant, row.key, at);
        if (changes > 0) this.#insertAudit(next, row.tenant, row.key, 'purge', null, row.expires_at);
      }
    });
    return { purged: expired.length, revision };
  }

  audit(tenant, { limit = 100 } = {}) {
    const db = this.#open();
    checkText(tenant, 'tenant');
    if (!Number.isInteger(limit) || limit <= 0) throw new ValidationError('limit must be a positive integer');
    let rows;
    try {
      rows = db.prepare(
        'SELECT revision, tenant, key, action, value_json, expires_at FROM audit WHERE tenant=? ORDER BY id DESC LIMIT ?'
      ).all(tenant, limit);
    } catch (cause) {
      throw new StorageError('audit failed', { cause });
    }
    return rows.map(row => ({
      revision: row.revision,
      tenant: row.tenant,
      key: row.key,
      action: row.action,
      value: row.value_json === null ? null : JSON.parse(row.value_json),
      expiresAt: row.expires_at,
    }));
  }

  #insertAudit(revision, tenant, key, action, valueJson, expiresAt) {
    this.#db.prepare(
      'INSERT INTO audit(revision, tenant, key, action, value_json, expires_at) VALUES(?,?,?,?,?,?)'
    ).run(revision, tenant, key, action, valueJson, expiresAt);
  }

  close() {
    if (!this.#closed) {
      this.#closed = true;
      this.#db.close();
    }
  }
}
