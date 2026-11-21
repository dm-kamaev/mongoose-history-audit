import { AuditInitiator } from '../context/types';
import { AuditContext, runWithAuditContext, resolveInitiator } from '../context/user_context';

export interface AuditContextHookOptions {
    /**
     * Extracts the id of the person who changed the data from the request.
     * Defaults to `request.user?._id ?? request.user?.id ?? null`.
     */
    getUserId?: (request: any) => any;
    /** Channel recorded in the `initiator` field. Defaults to `'http'`. */
    initiator?: AuditInitiator | (() => AuditInitiator | string | undefined);
}

type DoneFunction = (err?: Error) => void;

/**
 * Creates a Fastify `onRequest` hook that activates the audit context for the
 * whole request: every mongoose write performed while handling the request sees
 * `{ enabled: true, userId, initiator }`. Zero dependencies — works on the
 * library's own AsyncLocalStorage.
 *
 * ```ts
 * fastify.addHook('onRequest', createAuditContextHook());
 * fastify.addHook('onRequest', createAuditContextHook({ getUserId: req => req.accountId }));
 * ```
 *
 * If you already use `@fastify/request-context`, you can skip this hook and
 * register a `setAuditContextResolver()` reading from it instead.
 */
export function createAuditContextHook(options: AuditContextHookOptions = {}): (request: any, reply: any, done: DoneFunction) => void {
    const extract = options.getUserId ?? ((request: any) => request?.user?._id ?? request?.user?.id ?? null);

    return (request, _reply, done) => {
        const context: AuditContext & { initiator: AuditInitiator } = {
            enabled: true,
            userId: extract(request),
            initiator: resolveInitiator(options.initiator ?? AuditInitiator.http),
        };
        // Calling `done` inside als.run propagates the store to every async
        // continuation Fastify starts for the rest of this request.
        runWithAuditContext(context, () => done());
    };
}
