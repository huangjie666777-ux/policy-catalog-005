import { DatabaseSync } from 'node:sqlite';
import { ClosedError, ConflictError, StorageError, ValidationError } from './errors.mjs';

export { CatalogError, ClosedError, ConflictError, StorageError, ValidationError } from './errors.mjs';

function assertJsonSerializable(value, label = 'value') {
  const seen = new Set();
  const walk = node => {
    const kind = typeof node;
    if (kind === 'undefined') throw new ValidationError(`${label} must be JSON serializable (undefined is not allowed)`);
    if (kind === 'bigint') throw new ValidationError(`${label} must be JSON serializable (BigInt is not allowed)`);
    if (kind === 'function' || kind === 'symbol') throw new ValidationError(`${label} must be JSON serializable`);
    if (kind === 'number' && !Number.isFinite(node)) {
      throw new ValidationError(`${label} must be JSON serializable (NaN and Infinity are not allowed)`);
    }
    if (node !== null && kind === 'object') {
      if (seen.has(node)) throw new ValidationError(`${label} must be JSON serializable (circular reference)`);
      seen.add(node);
      if (Array.isArray(node)) {
        for (const item of node) walk(item);
      } else {
        for (const key of Object.keys(node)) walk(node[key]);
      }
      seen.delete(node);
    }
  };
  walk(value);
  try {
    JSON.stringify(value);
  } catch (cause) {
    throw new ValidationError(`${label} must be JSON serializable`, { cause });
  }
}

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`${label} must be a non-empty string`);
  }
}

function assertExpiresAt(value) {
  if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
    throw new ValidationError('expiresAt must be null or a non-negative integer (milliseconds)');
  }
}

function assertExpectedRevision(value) {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new ValidationError('expectedRevision must be a non-negative integer');
  }
}

export function openCatalog(filename, options = {}) {
  return new Catalog(filename, options);
}

export class Catalog {
  #db;
  #now;
  #closed = false;
  #statements;

  constructor(filename, { now = () => Date.now() } = {}) {
    if (typeof now !== 'function') throw new ValidationError('now must be a function');
    this.#now = now;
    let db;
    try {
      db = new DatabaseSync(filename);
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA busy_timeout = 5000');
      db.exec('PRAGMA foreign_keys = ON');
      db.exec(`
        CREATE TABLE IF NOT EXISTS meta (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          revision INTEGER NOT NULL
        );
        INSERT OR IGNORE INTO meta (id, revision) VALUES (1, 0);
        CREATE TABLE IF NOT EXISTS policies (
          tenant TEXT NOT NULL,
          key TEXT NOT NULL,
          value_json TEXT NOT NULL,
          revision INTEGER NOT NULL,
          expires_at INTEGER,
          PRIMARY KEY (tenant, key)
        ) WITHOUT ROWID;
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
      if (db) { try { db.close(); } catch { /* unusable */ } }
      if (cause instanceof ValidationError) throw cause;
      throw new StorageError('failed to open catalog', { cause });
    }
    this.#db = db;
    this.#statements = {
      currentRevision: db.prepare('SELECT revision FROM meta WHERE id = 1'),
      setRevision: db.prepare('UPDATE meta SET revision = ? WHERE id = 1'),
      getPolicy: db.prepare('SELECT value_json, revision, expires_at FROM policies WHERE tenant = ? AND key = ?'),
      listPolicies: db.prepare("SELECT key, value_json, revision, expires_at FROM policies WHERE tenant = ? AND key LIKE ? ESCAPE '\\' ORDER BY key ASC"),
      upsertPolicy: db.prepare(`INSERT INTO policies (tenant, key, value_json, revision, expires_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(tenant, key) DO UPDATE SET
          value_json = excluded.value_json,
          revision = excluded.revision,
          expires_at = excluded.expires_at`),
      deletePolicy: db.prepare('DELETE FROM policies WHERE tenant = ? AND key = ?'),
      insertAudit: db.prepare('INSERT INTO audit (revision, tenant, key, action, value_json, expires_at) VALUES (?, ?, ?, ?, ?, ?)'),
      expiredRows: db.prepare('SELECT tenant, key FROM policies WHERE expires_at IS NOT NULL AND expires_at <= ?'),
      auditByTenant: db.prepare('SELECT revision, tenant, key, action, value_json, expires_at AS expiresAt FROM audit WHERE tenant = ? ORDER BY id ASC LIMIT ?'),
    };
  }

  #requireOpen() {
    if (this.#closed) throw new ClosedError('Catalog is closed');
    return this.#db;
  }

  #storage(fn, message) {
    try {
      return fn();
    } catch (cause) {
      if (cause instanceof ClosedError || cause instanceof ConflictError || cause instanceof ValidationError) throw cause;
      throw new StorageError(message, { cause });
    }
  }

  #currentRevisionLocked() {
    return this.#statements.currentRevision.get().revision;
  }

  #nextRevisionLocked() {
    const next = this.#currentRevisionLocked() + 1;
    this.#statements.setRevision.run(next);
    return next;
  }

  #putLocked(tenant, key, valueJson, expiresAt) {
    const revision = this.#nextRevisionLocked();
    this.#statements.upsertPolicy.run(tenant, key, valueJson, revision, expiresAt);
    this.#statements.insertAudit.run(revision, tenant, key, 'put', valueJson, expiresAt);
    return revision;
  }

  #removeLocked(tenant, key) {
    const revision = this.#nextRevisionLocked();
    this.#statements.deletePolicy.run(tenant, key);
    this.#statements.insertAudit.run(revision, tenant, key, 'remove', null, null);
    return revision;
  }

  #readAt(options = {}) {
    const at = options.at ?? this.#now();
    if (!Number.isSafeInteger(at) || at < 0) throw new ValidationError('at must be a non-negative integer (milliseconds)');
    return at;
  }

  #escapeLike(text) {
    return text.replace(/[\\%_]/g, match => `\\${match}`);
  }

  #inTransaction(fn, message) {
    const db = this.#db;
    return this.#storage(() => {
      try {
        db.exec('BEGIN IMMEDIATE');
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (cause) {
        try { db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
        throw cause;
      }
    }, message);
  }

  revision() {
    this.#requireOpen();
    return this.#storage(() => this.#statements.currentRevision.get().revision, 'failed to read revision');
  }

  get(tenant, key, options = {}) {
    this.#requireOpen();
    assertNonEmptyString(tenant, 'tenant');
    assertNonEmptyString(key, 'key');
    const at = this.#readAt(options);
    const row = this.#storage(() => this.#statements.getPolicy.get(tenant, key), 'get failed');
    if (!row || (row.expires_at !== null && row.expires_at <= at)) return undefined;
    return {
      tenant,
      key,
      value: JSON.parse(row.value_json),
      revision: row.revision,
      expiresAt: row.expires_at,
    };
  }

  list(tenant, options = {}) {
    this.#requireOpen();
    assertNonEmptyString(tenant, 'tenant');
    const prefix = options.prefix ?? '';
    if (typeof prefix !== 'string') throw new ValidationError('prefix must be a string');
    const at = this.#readAt(options);
    const rows = this.#storage(
      () => this.#statements.listPolicies.all(tenant, `${this.#escapeLike(prefix)}%`),
      'list failed',
    );
    const entries = [];
    for (const row of rows) {
      if (row.expires_at !== null && row.expires_at <= at) continue;
      entries.push({
        tenant,
        key: row.key,
        value: JSON.parse(row.value_json),
        revision: row.revision,
        expiresAt: row.expires_at,
      });
    }
    return entries;
  }

  put(tenant, key, value, options = {}) {
    this.#requireOpen();
    assertNonEmptyString(tenant, 'tenant');
    assertNonEmptyString(key, 'key');
    assertJsonSerializable(value);
    const expiresAt = options.expiresAt ?? null;
    assertExpiresAt(expiresAt);
    const expectedRevision = options.expectedRevision;
    assertExpectedRevision(expectedRevision);
    const valueJson = JSON.stringify(value);
    return this.#inTransaction(() => {
      const current = this.#currentRevisionLocked();
      if (expectedRevision !== undefined && current !== expectedRevision) {
        throw new ConflictError(`revision conflict: expected ${expectedRevision}, current ${current}`);
      }
      const revision = this.#putLocked(tenant, key, valueJson, expiresAt);
      return { revision };
    }, 'put failed');
  }

  remove(tenant, key, options = {}) {
    this.#requireOpen();
    assertNonEmptyString(tenant, 'tenant');
    assertNonEmptyString(key, 'key');
    const expectedRevision = options.expectedRevision;
    assertExpectedRevision(expectedRevision);
    return this.#inTransaction(() => {
      const current = this.#currentRevisionLocked();
      if (expectedRevision !== undefined && current !== expectedRevision) {
        throw new ConflictError(`revision conflict: expected ${expectedRevision}, current ${current}`);
      }
      const revision = this.#removeLocked(tenant, key);
      return { revision };
    }, 'remove failed');
  }

  applyBatch(tenant, operations, options = {}) {
    this.#requireOpen();
    assertNonEmptyString(tenant, 'tenant');
    if (!Array.isArray(operations) || operations.length === 0) {
      throw new ValidationError('operations must be a non-empty array');
    }
    const expectedRevision = options.expectedRevision;
    assertExpectedRevision(expectedRevision);
    const normalized = operations.map((operation, index) => {
      if (operation === null || typeof operation !== 'object') {
        throw new ValidationError(`operations[${index}] must be an object`);
      }
      assertNonEmptyString(operation.key, `operations[${index}].key`);
      const expiresAt = operation.expiresAt ?? null;
      assertExpiresAt(expiresAt);
      if (operation.action === 'put') {
        assertJsonSerializable(operation.value, `operations[${index}].value`);
        return { action: 'put', key: operation.key, valueJson: JSON.stringify(operation.value), expiresAt };
      }
      if (operation.action === 'remove') return { action: 'remove', key: operation.key };
      throw new ValidationError(`operations[${index}].action must be "put" or "remove"`);
    });
    return this.#inTransaction(() => {
      const baseRevision = this.#currentRevisionLocked();
      if (expectedRevision !== undefined && baseRevision !== expectedRevision) {
        throw new ConflictError(`revision conflict: expected ${expectedRevision}, current ${baseRevision}`);
      }
      const revisions = [];
      for (const operation of normalized) {
        if (operation.action === 'put') {
          revisions.push(this.#putLocked(tenant, operation.key, operation.valueJson, operation.expiresAt));
        } else {
          revisions.push(this.#removeLocked(tenant, operation.key));
        }
      }
      return { revision: revisions[revisions.length - 1], revisions };
    }, 'applyBatch failed');
  }

  purgeExpired(options = {}) {
    this.#requireOpen();
    const at = this.#readAt(options);
    return this.#inTransaction(() => {
      const rows = this.#statements.expiredRows.all(at);
      let revision;
      for (const row of rows) {
        revision = this.#nextRevisionLocked();
        this.#statements.deletePolicy.run(row.tenant, row.key);
        this.#statements.insertAudit.run(revision, row.tenant, row.key, 'purge', null, null);
      }
      return { count: rows.length, revision: revision ?? this.#currentRevisionLocked() };
    }, 'purgeExpired failed');
  }

  audit(tenant, options = {}) {
    this.#requireOpen();
    assertNonEmptyString(tenant, 'tenant');
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new ValidationError('limit must be a positive integer');
    const rows = this.#storage(() => this.#statements.auditByTenant.all(tenant, limit), 'audit failed');
    return rows.map(row => ({
      revision: row.revision,
      tenant: row.tenant,
      key: row.key,
      action: row.action,
      value: row.value_json === null ? null : JSON.parse(row.value_json),
      expiresAt: row.expiresAt,
    }));
  }

  close() {
    if (this.#closed) throw new ClosedError('Catalog is closed');
    this.#closed = true;
    try {
      this.#db.close();
    } catch (cause) {
      throw new StorageError('failed to close catalog', { cause });
    }
  }
}
