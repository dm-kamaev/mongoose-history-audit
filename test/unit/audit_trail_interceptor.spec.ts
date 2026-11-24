import 'reflect-metadata';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { AuditTrailInterceptor } from '../../src/nest/audit_trail.interceptor';
import { AUDIT_TRAIL_KEY, AuditTrailOptions, createAuditTrailDecorator } from '../../src/nest/audit_trail.decorator';
import { AuditError } from '../../src/context/errors';
import { getAuditContext, isKnownSource, resetAuditSources } from '../../src/context/user_context';

class FakeController {}

function make_context(partial: {
    type: string;
    handler?: any;
    request?: any;
    args?: any[];
    rpc_context?: any;
    ws_data?: any;
}): ExecutionContext {
    return {
        getHandler: () => partial.handler ?? (() => undefined),
        getClass: () => FakeController,
        getType: () => partial.type,
        switchToHttp: () => ({ getRequest: () => partial.request, getResponse: () => ({}) }),
        switchToRpc: () => ({ getData: () => undefined, getContext: () => partial.rpc_context }),
        switchToWs: () => ({ getData: () => partial.ws_data, getClient: () => undefined }),
        getArgs: () => partial.args ?? [],
        getArgByIndex: (index: number) => (partial.args ?? [])[index],
    } as unknown as ExecutionContext;
}

function decorate(handler: any, options: AuditTrailOptions): any {
    Reflect.defineMetadata(AUDIT_TRAIL_KEY, options, handler);
    return handler;
}

/** Runs `intercept()` and returns the audit context visible inside the handler. */
function context_inside_handler(interceptor: AuditTrailInterceptor, context: ExecutionContext): any {
    let seen: any;
    const next = {
        handle: () =>
            new Observable(subscriber => {
                seen = getAuditContext();
                subscriber.next({});
                subscriber.complete();
            }),
    };
    interceptor.intercept(context, next as any).subscribe();
    return seen;
}

describe('AuditTrailInterceptor — transport-aware createAuditContext seam', () => {
    let interceptor: AuditTrailInterceptor;

    beforeEach(() => {
        interceptor = new AuditTrailInterceptor(new Reflector());
    });

    afterEach(() => resetAuditSources());

    it('http: enabled, req.user convention, source http', () => {
        const handler = decorate(() => undefined, {});
        const context = make_context({ type: 'http', handler, request: { user: { _id: '64e5faee64e5faee64e5faee' } } });

        const seen = context_inside_handler(interceptor, context);
        expect(seen).toEqual({ enabled: true, modifiedBy: '64e5faee64e5faee64e5faee', source: 'http' });
    });

    it('http without metadata: explicitly disabled (no leak)', () => {
        const context = make_context({ type: 'http', request: { user: { _id: 'x' } } });

        const seen = context_inside_handler(interceptor, context);
        expect(seen.enabled).toBe(false);
    });

    it('rpc: default is a system record with source rpc', () => {
        const handler = decorate(() => undefined, {});
        const context = make_context({ type: 'rpc', handler });

        const seen = context_inside_handler(interceptor, context);
        expect(seen).toEqual({ enabled: true, modifiedBy: null, source: 'rpc' });
    });

    it('rpc custom getModifiedBy reads a metadata header (userland extraction)', () => {
        const handler = decorate(() => undefined, {
            getModifiedBy: ctx => ctx.switchToRpc().getContext()?.get('x-user-id')?.[0] ?? null,
        });
        const rpc_context = { get: (key: string) => (key === 'x-user-id' ? ['user-from-grpc'] : []) };
        const context = make_context({ type: 'rpc', handler, rpc_context });

        const seen = context_inside_handler(interceptor, context);
        expect(seen).toEqual({ enabled: true, modifiedBy: 'user-from-grpc', source: 'rpc' });
    });

    it('ws: default is a system record with source ws', () => {
        const handler = decorate(() => undefined, {});
        const context = make_context({ type: 'ws', handler, ws_data: { hello: 1 } });

        const seen = context_inside_handler(interceptor, context);
        expect(seen).toEqual({ enabled: true, modifiedBy: null, source: 'ws' });
    });

    it('graphql: extracts user from the Apollo { req } context (resolver arg 3)', () => {
        const handler = decorate(() => undefined, {});
        const gql_context = { req: { user: { id: '64e5faee64e5faee64e5faee' } } };
        const context = make_context({ type: 'graphql', handler, args: [{}, {}, gql_context] });

        const seen = context_inside_handler(interceptor, context);
        expect(seen).toEqual({ enabled: true, modifiedBy: '64e5faee64e5faee64e5faee', source: 'graphql' });
    });

    it('source option overrides the transport default (built-in needs no registration)', () => {
        const handler = decorate(() => undefined, { source: 'graphql' });
        const context = make_context({ type: 'http', handler, request: {} });

        const seen = context_inside_handler(interceptor, context);
        expect(seen.source).toBe('graphql');
    });

    it('source option with an unregistered name throws AuditError', () => {
        const handler = decorate(() => undefined, { source: 'nope' });
        const context = make_context({ type: 'http', handler, request: {} });

        expect(() => interceptor.intercept(context, { handle: () => new Observable() } as any)).toThrow(AuditError);
    });

    it('unknown transport type falls back to null modifiedBy / source http', () => {
        const handler = decorate(() => undefined, {});
        const context = make_context({ type: 'weird-future-transport', handler });

        const seen = context_inside_handler(interceptor, context);
        expect(seen).toEqual({ enabled: true, modifiedBy: null, source: 'http' });
    });

    it('subclass override replaces one transport and falls back to super for the rest', () => {
        class CustomInterceptor extends AuditTrailInterceptor {
            protected createAuditContext(context: ExecutionContext, options?: AuditTrailOptions) {
                if (context.getType() === 'rpc') {
                    return { enabled: true, modifiedBy: 'from-subclass', source: 'rpc' as const };
                }
                return super.createAuditContext(context, options);
            }
        }
        const custom = new CustomInterceptor(new Reflector());

        const rpc_handler = decorate(() => undefined, {});
        const rpc_seen = context_inside_handler(custom, make_context({ type: 'rpc', handler: rpc_handler }));
        expect(rpc_seen).toEqual({ enabled: true, modifiedBy: 'from-subclass', source: 'rpc' });

        const http_handler = decorate(() => undefined, {});
        const http_seen = context_inside_handler(
            custom,
            make_context({ type: 'http', handler: http_handler, request: { user: { id: 'http-id' } } }),
        );
        expect(http_seen).toEqual({ enabled: true, modifiedBy: 'http-id', source: 'http' });
    });

    it('getModifiedBy receives the whole ExecutionContext (http branch)', () => {
        const handler = decorate(() => undefined, {
            getModifiedBy: ctx => `${ctx.getType()}:${ctx.switchToHttp().getRequest()?.headers?.['x-tenant']}`,
        });
        const context = make_context({ type: 'http', handler, request: { headers: { 'x-tenant': 'acme' } } });

        const seen = context_inside_handler(interceptor, context);
        expect(seen.modifiedBy).toBe('http:acme');
    });
});

describe('createAuditTrailDecorator (preset factory)', () => {
    let interceptor: AuditTrailInterceptor;

    beforeEach(() => {
        interceptor = new AuditTrailInterceptor(new Reflector());
    });

    afterEach(() => resetAuditSources());

    function apply_preset(preset: ReturnType<typeof createAuditTrailDecorator>, per_call?: AuditTrailOptions): any {
        const method = function () {};
        preset(per_call)(FakeController.prototype, 'handle', { value: method } as any);
        return method;
    }

    it('bakes source + getModifiedBy and self-registers the source (no startup call)', () => {
        const GrpcFrontAuditTrail = createAuditTrailDecorator({
            source: 'grpc(front)',
            getModifiedBy: ctx => ctx.switchToRpc().getContext()?.get('x-user')?.[0] ?? null,
        });
        const handler = apply_preset(GrpcFrontAuditTrail);
        expect(isKnownSource('grpc(front)')).toBe(true);

        const context = make_context({ type: 'rpc', handler, rpc_context: { get: () => ['user-1'] } });
        expect(context_inside_handler(interceptor, context)).toEqual({
            enabled: true,
            modifiedBy: 'user-1',
            source: 'grpc(front)',
        });
    });

    it('per-call options override baked defaults and self-register their source too', () => {
        const preset = createAuditTrailDecorator({ source: 'grpc(front)' });
        const handler = apply_preset(preset, { source: 'weird-override' });
        expect(isKnownSource('weird-override')).toBe(true);

        const context = make_context({ type: 'rpc', handler });
        expect(context_inside_handler(interceptor, context).source).toBe('weird-override');
    });

    it('keeps the baked getModifiedBy when only source is overridden per call', () => {
        const preset = createAuditTrailDecorator({ getModifiedBy: () => 'baked-user' });
        const handler = apply_preset(preset, { source: 'rpc' });

        const context = make_context({ type: 'rpc', handler });
        expect(context_inside_handler(interceptor, context)).toEqual({
            enabled: true,
            modifiedBy: 'baked-user',
            source: 'rpc',
        });
    });
});
