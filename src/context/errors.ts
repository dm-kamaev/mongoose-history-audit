/**
 * Error thrown by the library for its own misuse: an unregistered audit
 * source, a missing `Model.bulkWrite`, etc. Catch it with
 * `instanceof AuditError` (or check `err.name === 'AuditError'`).
 */
export class AuditError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'AuditError';
    }
}
