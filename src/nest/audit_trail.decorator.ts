import { ExecutionContext, SetMetadata } from '@nestjs/common';
import { registerAuditSources } from '../context/user_context';
import { AuditSource } from '../context/types';

export const AUDIT_TRAIL_KEY = 'audit_trail';

export interface AuditTrailOptions {
    /**
     * Extracts the id of the person who changed the data from the execution
     * context. Defaults per transport: `http`/`graphql` → `user._id ?? user.id ?? null`
     * from the request; `rpc`/`ws` → `null` (system record).
     *
     * Receives the whole `ExecutionContext` so any transport can be read:
     * `ctx.switchToHttp().getRequest()` (HTTP), `ctx.getArgs()[2].req` (GraphQL
     * context under Apollo), `ctx.switchToRpc().getContext()` (gRPC metadata —
     * note `get()` returns `string[]`), `ctx.switchToWs().getData()` (WebSocket).
     * Because guards run before interceptors, `request.user` set by an auth
     * guard is already visible for HTTP.
     */
    getModifiedBy?: (context: ExecutionContext) => any;
    /**
     * Channel recorded in the `source` field, validated — an unregistered
     * name throws `AuditError` (register it with `registerAuditSources()`).
     * Defaults per transport: `http` / `graphql` / `rpc` / `ws`.
     */
    source?: AuditSource | (() => AuditSource | string | undefined);
}

/**
 * Marks a route handler or controller class as audited: the `AuditTrailInterceptor`
 * reads this metadata and activates the audit context (`enabled: true`, `modifiedBy`
 * from the execution context, transport default `source`) for the duration of the handler.
 *
 * `@AuditTrail()` / `@AuditTrail(true)` — audit with the default user extraction,
 * `@AuditTrail(false)` — explicitly skip (also resets an inherited flag),
 * `@AuditTrail({ getModifiedBy, source })` — custom extraction and/or channel.
 * Without the decorator the interceptor explicitly disables the context so it
 * cannot leak from a previous request.
 */
export const AuditTrail = (target_or_options: boolean | AuditTrailOptions = true): MethodDecorator & ClassDecorator => {
    if (typeof target_or_options === 'boolean') {
        return SetMetadata(AUDIT_TRAIL_KEY, target_or_options ? {} : false);
    }
    return SetMetadata(AUDIT_TRAIL_KEY, target_or_options ?? {});
};

/**
 * Creates a named preset decorator with baked-in `AuditTrail` defaults.
 * Per-call options override the baked-in defaults (shallow merge).
 * Any string `source` written into the factory or a per-call override
 * registers itself — no separate `registerAuditSources()` call needed
 * (thunk sources still require registration at startup):
 *
 * ```ts
 * const GrpcFrontAuditTrail = createAuditTrailDecorator({
 *     source: 'grpc(front)',
 *     getModifiedBy: ctx => ctx.switchToRpc().getContext()?.get('authorization')?.[0] ?? null,
 * });
 *
 * @Post()
 * @GrpcFrontAuditTrail()
 * handle() { ... }
 * ```
 */
export function createAuditTrailDecorator(defaults: AuditTrailOptions): (options?: AuditTrailOptions) => MethodDecorator & ClassDecorator {
    return (options: AuditTrailOptions = {}) => {
        const merged = { ...defaults, ...options };
        if (typeof merged.source === 'string') {
            registerAuditSources(merged.source);
        }
        return AuditTrail(merged);
    };
}
