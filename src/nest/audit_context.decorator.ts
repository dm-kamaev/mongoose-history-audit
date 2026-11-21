import { AuditInitiator, AuditLogger } from '../context/types';
import { resolveInitiator, runWithAuditContext } from '../context/user_context';

export interface AuditContextOptions {
    initiator?: AuditInitiator | (() => AuditInitiator | string | undefined);
    userId?: any;
    logger?: AuditLogger;
}

/**
 * Runs the decorated command handler inside `runWithAuditContext`
 * with `{ enabled: true, userId, initiator }`. `initiator` is either a known
 * `AuditInitiator` member, a raw string (e.g. `'kafka'`, registered via
 * `registerAuditInitiators()`) or a function returning them (resolved at call
 * time: `() => process.env.HISTORY_INITIATOR`); unregistered raw values are
 * written through unchanged and reported through `options.logger`. Defaults to
 * `userId: null` (system record) and `initiator: 'cli'`.
 *
 * Reflect metadata is copied onto the wrapper so decorators like nestjs-command's
 * `@Command`/`@Option` keep working regardless of stacking order.
 */
export function AuditContext(options: AuditContextOptions = {}): MethodDecorator {
    return (target, propertyKey, descriptor) => {
        const original = descriptor.value as (...args: any[]) => Promise<any>;
        const wrapper = function (this: any, ...args: any[]) {
            return runWithAuditContext(
                {
                    enabled: true,
                    userId: options.userId ?? null,
                    initiator: resolveInitiator(options.initiator ?? AuditInitiator.cli, options.logger),
                },
                () => original.apply(this, args),
            );
        };

        const meta = Reflect as any;
        const meta_keys: Array<string | symbol> = typeof meta.getMetadataKeys === 'function' ? meta.getMetadataKeys(original) : [];
        for (const key of meta_keys) {
            meta.defineMetadata(key, meta.getMetadata(key, original), wrapper);
        }

        descriptor.value = wrapper as any;
        return descriptor;
    };
}

/**
 * Creates a named preset decorator with baked-in `AuditContext` defaults.
 * Per-call options override the baked-in defaults (shallow merge):
 *
 * ```ts
 * const KafkaAuditContext = createAuditContextDecorator({ initiator: 'kafka' });
 * @KafkaAuditContext({ userId })
 * async handle(msg) { ... }
 * ```
 */
export function createAuditContextDecorator(defaults: AuditContextOptions): (options?: AuditContextOptions) => MethodDecorator {
    return (options: AuditContextOptions = {}) => AuditContext({ ...defaults, ...options });
}
