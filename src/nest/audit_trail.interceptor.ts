import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { AUDIT_TRAIL_KEY, AuditTrailOptions } from './audit_trail.decorator';
import { AuditInitiator } from '../context/types';
import { AuditContext, runWithAuditContext } from '../context/user_context';

function default_get_user_id(request: any): any {
    return request?.user?._id ?? request?.user?.id ?? null;
}

/**
 * Activates the audit context for handlers marked with `@AuditTrail()`.
 * Uses the library's own AsyncLocalStorage — no CLS dependency: the handler
 * subscription runs inside `runWithAuditContext`, so every mongoose write the
 * handler (or anything it awaits) performs sees
 * `{ enabled: true, userId, initiator: 'http' }`.
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

        const is_http = context.getType() === 'http';
        const decorated = options !== false && options !== undefined;
        const enabled = decorated && is_http;

        let audit_context: AuditContext & { initiator: AuditInitiator };
        if (enabled) {
            const request = context.switchToHttp().getRequest();
            const extract = (options as AuditTrailOptions).getUserId ?? default_get_user_id;
            audit_context = { enabled: true, userId: extract(request), initiator: AuditInitiator.http };
        } else {
            audit_context = { enabled: false, initiator: AuditInitiator.http };
        }

        return new Observable(subscriber => {
            let subscription: { unsubscribe(): void } | undefined;
            runWithAuditContext(audit_context, () => {
                subscription = next.handle().subscribe(subscriber);
            });
            return () => subscription?.unsubscribe();
        });
    }
}
