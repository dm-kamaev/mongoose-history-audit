import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { AUDIT_TRAIL_KEY, AuditTrailOptions } from './audit_trail.decorator';
import { AuditContext, resolveSource, runWithAuditContext } from '../context/user_context';
import { AuditSource } from '../context/types';

function read_user(request: any): any {
    return request?.user?._id ?? request?.user?.id ?? null;
}

const DEFAULT_SOURCE_BY_TYPE: Record<string, AuditSource> = {
    http: 'http',
    graphql: 'graphql',
    rpc: 'rpc',
    ws: 'ws',
};

const DEFAULT_EXTRACTOR_BY_TYPE: Record<string, (context: ExecutionContext) => any> = {
    http: context => read_user(context.switchToHttp().getRequest()),
    // Apollo puts `{ req, res }` in the GraphQL context (resolver arg 3).
    // `GqlExecutionContext` would need a hard @nestjs/graphql dependency.
    graphql: context => read_user(context.getArgs()[2]?.req),
    // No auth convention exists for a raw RPC/WS payload — userland reads
    // metadata/handshake headers via the `getModifiedBy` option instead.
    rpc: () => null,
    ws: () => null,
};

/**
 * Activates the audit context for handlers marked with `@AuditTrail()`.
 * Uses the library's own AsyncLocalStorage — no CLS dependency: the handler
 * subscription runs inside `runWithAuditContext`, so every mongoose write the
 * handler (or anything it awaits) performs sees the built audit context.
 *
 * Works on every transport: `http`, `graphql`, `rpc` (gRPC/NATS/Kafka/…),
 * `ws` — the protected `createAuditContext()` decides per `context.getType()`.
 *
 * When the decorator is absent or disabled, the handler still runs inside a
 * context with `enabled: false` so a nested `runWithAuditContext` is the only
 * way to re-enable auditing — ambient state cannot leak between requests.
 */
@Injectable()
export class AuditTrailInterceptor implements NestInterceptor {
    constructor(private readonly reflector: Reflector) {}

    intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
        const options = this.reflector.getAllAndOverride<boolean | AuditTrailOptions | undefined>(AUDIT_TRAIL_KEY, [
            context.getHandler(),
            context.getClass(),
        ]);

        const decorated = options !== false && options !== undefined;
        const audit_context: AuditContext & { source: AuditSource } = decorated
            ? this.createAuditContext(context, options as AuditTrailOptions)
            : { enabled: false, source: 'http' };

        return new Observable(subscriber => {
            let subscription: { unsubscribe(): void } | undefined;
            runWithAuditContext(audit_context, () => {
                subscription = next.handle().subscribe(subscriber);
            });
            return () => subscription?.unsubscribe();
        });
    }

    /**
     * Builds the audit context for a decorated handler — the single extension
     * seam. Override it in a subclass to add or replace extraction for one
     * transport and always fall through for the rest:
     *
     * ```ts
     * if (context.getType() === 'rpc') return { enabled: true, modifiedBy: …, source: 'rpc' };
     * return super.createAuditContext(context, options);
     * ```
     *
     * Defaults: `http`/`graphql` → `request.user` convention, `rpc`/`ws` →
     * `null` (system record); `options.source` overrides the transport default
     * and is validated — an unregistered name throws `AuditError`.
     */
    protected createAuditContext(context: ExecutionContext, options?: AuditTrailOptions): AuditContext & { source: AuditSource } {
        const type = context.getType() as string;
        const extract = options?.getModifiedBy ?? DEFAULT_EXTRACTOR_BY_TYPE[type] ?? (() => null);
        return {
            enabled: true,
            modifiedBy: extract(context),
            source: resolveSource(options?.source ?? DEFAULT_SOURCE_BY_TYPE[type] ?? 'http'),
        };
    }
}
