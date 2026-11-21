import { AsyncLocalStorage } from 'node:async_hooks';
import { Types } from 'mongoose';
import { SYSTEM_AUDIT_MODIFIED_BY } from './constants';
import { AuditError } from './errors';
import { AuditSource } from './types';

/**
 * Context of the current audit operation, resolved by the consumer.
 * The library itself is framework-agnostic and does not know where the
 * context comes from - it only reads what is registered via
 * `setAuditContextResolver()` (e.g. a nestjs-cls backed resolver) or set
 * explicitly through `runWithAuditContext()`.
 */
export interface AuditContext {
    enabled: boolean;
    modifiedBy?: Types.ObjectId | string | null;
    source?: AuditSource;
}

export type AuditContextResolver = () => AuditContext | undefined;

let resolver: AuditContextResolver | undefined;

const scoped_context = new AsyncLocalStorage<AuditContext>();

const BUILT_IN_SOURCES = ['http', 'cron', 'cli', 'rabbitmq'];

const known_sources = new Set<string>(BUILT_IN_SOURCES);

/**
 * Registers extra source names accepted by validation. Required before a
 * custom channel (e.g. `'kafka'`) can be used — an unregistered value throws.
 * Idempotent, additive; call once at application startup.
 */
export function registerAuditSources(...names: string[]): void {
    for (const name of names) {
        if (name) {
            known_sources.add(name);
        }
    }
}

/** Removes registered source names. Intended for tests. */
export function resetAuditSources(): void {
    known_sources.clear();
    for (const name of BUILT_IN_SOURCES) {
        known_sources.add(name);
    }
}

/** Reports whether an source is known (built-in or registered). */
export function isKnownSource(name: string): boolean {
    return known_sources.has(name);
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

export function getAuditModifiedBy(): Types.ObjectId | null {
    const raw = getAuditContext()?.modifiedBy;
    if (raw === null || raw === undefined) {
        return SYSTEM_AUDIT_MODIFIED_BY;
    }
    if (raw instanceof Types.ObjectId) {
        return raw;
    }
    return Types.ObjectId.isValid(raw) ? new Types.ObjectId(raw) : SYSTEM_AUDIT_MODIFIED_BY;
}

export function getAuditSource(): AuditSource | undefined {
    return getAuditContext()?.source;
}

/**
 * Runs `fn` with a fixed audit context (e.g. `{ enabled: true, modifiedBy, source: 'http' }`).
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
export function runWithAuditContext<T>(context: AuditContext & { source: AuditSource }, fn: () => T): T {
    if (context.source !== undefined) {
        assertAuditSource(context.source);
    }
    const result = scoped_context.run(context, fn);
    if (result && typeof (result as any).then === 'function') {
        return scoped_context.run(context, () => Promise.resolve(result)) as T;
    }
    return result;
}

/** Throws when `name` is not a built-in or registered source. */
export function assertAuditSource(name: string): void {
    if (!isKnownSource(name)) {
        throw new AuditError(`Unknown audit source "${name}". Register it with registerAuditSources("${name}") at application startup.`);
    }
}

/**
 * Resolves `source` (literal or thunk) to a registered name.
 * `undefined`/`null` fall back to `'cli'`; an unregistered value throws.
 */
export function resolveSource(value: AuditSource | (() => AuditSource | string | undefined)): AuditSource {
    const raw = typeof value === 'function' ? value() : value;
    if (raw === undefined || raw === null) {
        return 'cli';
    }
    assertAuditSource(raw);
    return raw;
}
