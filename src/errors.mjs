export class CatalogError extends Error { constructor(message, options) { super(message, options); this.name = new.target.name; } }
export class ValidationError extends CatalogError {}
export class ConflictError extends CatalogError {}
export class ClosedError extends CatalogError {}
export class StorageError extends CatalogError {}
