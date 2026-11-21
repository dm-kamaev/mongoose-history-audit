import { AuditContext, AuditContextOptions } from './audit_context.decorator';

export { AuditContext, createAuditContextDecorator } from './audit_context.decorator';
export type { AuditContextOptions } from './audit_context.decorator';
export { AuditTrail, AUDIT_TRAIL_KEY } from './audit_trail.decorator';
export type { AuditTrailOptions } from './audit_trail.decorator';
export { AuditTrailInterceptor } from './audit_trail.interceptor';

/**
 * Convenience preset: CLI/cron context with `userId: null` (system record),
 * the shape used by scheduled jobs. Equivalent to `@AuditContext()`.
 */
export const CronAuditContext = (options: Omit<AuditContextOptions, 'userId'> = {}): MethodDecorator => AuditContext(options);
