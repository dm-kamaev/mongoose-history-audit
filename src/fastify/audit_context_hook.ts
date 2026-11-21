import { AuditContext, runWithAuditContext, resolveSource } from '../context/user_context';

export interface AuditContextHookOptions {
    /**
     * Extracts the id of the person who changed the data from the request.
     * Defaults to `request.user?._id ?? request.user?.id ?? null`.
     */
    getModifiedBy?: (request: any) => any;
    /** Channel recorded in the `source` field. Defaults to `'http'`. */
    source?: string | (() => string | undefined);
}

type DoneFunction = (err?: Error) => void;

/**
 * Creates a Fastify `onRequest` hook that activates the audit context for the
 * whole request: every mongoose write performed while handling the request sees
 * `{ enabled: true, modifiedBy, source }`. Zero dependencies — works on the
 * library's own AsyncLocalStorage.
 *
 * ```ts
 * fastify.addHook('onRequest', createAuditContextHook());
 * fastify.addHook('onRequest', createAuditContextHook({ getModifiedBy: req => req.accountId }));
 * ```
 *
 * If you already use `@fastify/request-context`, you can skip this hook and
 * register a `setAuditContextResolver()` reading from it instead.
 */
export function createAuditContextHook(options: AuditContextHookOptions = {}): (request: any, reply: any, done: DoneFunction) => void {
    const extract = options.getModifiedBy ?? ((request: any) => request?.user?._id ?? request?.user?.id ?? null);

    return (request, _reply, done) => {
        const context: AuditContext & { source: string } = {
            enabled: true,
            modifiedBy: extract(request),
            source: resolveSource(options.source ?? 'http'),
        };
        // Calling `done` inside als.run propagates the store to every async
        // continuation Fastify starts for the rest of this request.
        runWithAuditContext(context, () => done());
    };
}
