import { SetMetadata } from '@nestjs/common';

export const AUDIT_TRAIL_KEY = 'audit_trail';

export interface AuditTrailOptions {
    /**
     * Extracts the id of the person who changed the data from the request.
     * Defaults to `request.user._id ?? request.user.id ?? null`.
     */
    getModifiedBy?: (request: any) => any;
}

/**
 * Marks a route handler or controller class as audited: the `AuditTrailInterceptor`
 * reads this metadata and activates the audit context (`enabled: true`, `modifiedBy`
 * from the request, `source: 'http'`) for the duration of the handler.
 *
 * `@AuditTrail()` / `@AuditTrail(true)` — audit with the default user extraction,
 * `@AuditTrail(false)` — explicitly skip (also resets an inherited flag),
 * `@AuditTrail({ getModifiedBy })` — custom extraction of the person who changed the data.
 * Without the decorator the interceptor explicitly disables the context so it
 * cannot leak from a previous request.
 */
export const AuditTrail = (target_or_options: boolean | AuditTrailOptions = true): MethodDecorator & ClassDecorator => {
    if (typeof target_or_options === 'boolean') {
        return SetMetadata(AUDIT_TRAIL_KEY, target_or_options ? {} : false);
    }
    return SetMetadata(AUDIT_TRAIL_KEY, target_or_options ?? {});
};
