import { AsyncLocalStorage } from 'node:async_hooks';
import { Types } from 'mongoose';
import { SYSTEM_AUDIT_USER_ID } from './constants';
import { AuditInitiator, AuditLogger } from './types';

/**
 * Context of the current audit operation, resolved by the consumer.
 * The library itself is framework-agnostic and does not know where the
 * context comes from - it only reads what is registered via
 * `setAuditContextResolver()` (e.g. a nestjs-cls backed resolver) or set
 * explicitly through `runWithAuditContext()`.
 */
export interface AuditContext {
    enabled: boolean;
    userId?: Types.ObjectId | string | null;
    initiator?: AuditInitiator;
}

export type AuditContextResolver = () => AuditContext | undefined;

let resolver: AuditContextResolver | undefined;

const scoped_context = new AsyncLocalStorage<AuditContext>();

const known_initiators = new Set<string>(Object.values(AuditInitiator));

/**
 * Registers extra initiator names accepted by validation.
 * The values themselves are plain strings — registering only silences the
 * "unknown initiator" warning; unregistered values are still written to the
 * record unchanged. Idempotent, additive; call once at application startup.
 */
export function registerAuditInitiators(...names: string[]): void {
    for (const name of names) {
        if (name) {
            known_initiators.add(name);
        }
    }
}

/** Removes registered initiator names. Intended for tests. */
export function resetAuditInitiators(): void {
    known_initiators.clear();
    for (const name of Object.values(AuditInitiator)) {
        known_initiators.add(name);
    }
}

/** Reports whether an initiator is known (built-in or registered). */
export function isKnownInitiator(name: string): boolean {
    return known_initiators.has(name);
}

/**
 * Registers the resolver used to read the current audit context.
 * Call it once at application startup (repeated calls simply replace it).
 * Returns the previously registered resolver so callers can restore it.
 */
export function setAuditContextResolver(next: AuditContextResolver | undefined): AuditContextResolver | undefined {
    const previous = resolver;
    resolver = next;
    return previous;
}

/** Removes the registered resolver. Intended for tests. */
export function resetAuditContextResolver(): void {
    resolver = undefined;
}

/** Reads the current audit context: scoped context first, then the registered resolver. */
export function getAuditContext(): AuditContext | undefined {
    const scoped = scoped_context.getStore();
    if (scoped) {
        return scoped;
    }
    try {
        return resolver?.();
    } catch {
        return undefined;
    }
}

export function isAuditEnabled(): boolean {
    return Boolean(getAuditContext()?.enabled);
}

export function getAuditUserId(): Types.ObjectId | null {
    const raw = getAuditContext()?.userId;
    if (raw === null || raw === undefined) {
        return SYSTEM_AUDIT_USER_ID;
    }
    if (raw instanceof Types.ObjectId) {
        return raw;
    }
    return Types.ObjectId.isValid(raw) ? new Types.ObjectId(raw) : SYSTEM_AUDIT_USER_ID;
}

export function getAuditInitiator(): AuditInitiator | undefined {
    return getAuditContext()?.initiator;
}

/**
 * Runs `fn` with a fixed audit context (e.g. `{ enabled: true, userId, initiator: 'http' }`).
 * The context is scoped to `fn` via `AsyncLocalStorage`: concurrent operations
 * outside `fn` keep reading the registered resolver, and overlapping calls do
 * not affect each other. This is the primary way to set `modified_by`.
 *
 * Accepts sync and async `fn`; the return value is passed through, so async
 * callers still get a `Promise<T>`. If `fn` returns a thenable that is not a
 * native Promise (a lazy mongoose Query), the context is re-entered to settle
 * it — mongoose runs pre/post hooks when `.then()` is called, so without this
 * a query created inside the scope but awaited outside would lose the context.
 */
export function runWithAuditContext<T>(context: AuditContext & { initiator: AuditInitiator }, fn: () => T): T {
    const result = scoped_context.run(context, fn);
    if (result && typeof (result as any).then === 'function') {
        return scoped_context.run(context, () => Promise.resolve(result)) as T;
    }
    return result;
}

/**
 * Convenience wrapper around `runWithAuditContext` that pins `userId`
 * (the person who changed the data) and keeps the rest of the context
 * (initiator) from the ambient scope when present.
 */
export async function withHistoryUser<T>(userId: Types.ObjectId | string | null, fn: () => Promise<T>): Promise<T> {
    const current = getAuditContext();
    return runWithAuditContext(
        {
            enabled: true,
            userId,
            initiator: current?.initiator ?? AuditInitiator.cli,
        },
        fn,
    );
}

/**
 * Validates `initiator` against the known + registered set. Unknown values
 * produce a warning through `logger` but are returned unchanged — the audit
 * trail must record the real channel, not a fallback.
 */
export function resolveInitiator(
    value: AuditInitiator | string | (() => AuditInitiator | string | undefined),
    logger?: AuditLogger,
): AuditInitiator {
    const raw = typeof value === 'function' ? value() : value;
    if (raw === undefined || raw === null) {
        return AuditInitiator.cli;
    }
    if (!isKnownInitiator(raw)) {
        logger?.warn?.(`initiator "${raw}" is not registered; register it with registerAuditInitiators() to silence this warning`);
    }
    return raw;
}
