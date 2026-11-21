import { AuditSource } from '../context/types';
import { resolveSource, runWithAuditContext } from '../context/user_context';

export interface AuditContextOptions {
    source?: AuditSource | (() => AuditSource | string | undefined);
    modifiedBy?: any;
}

/**
 * Runs the decorated command handler inside `runWithAuditContext`
 * with `{ enabled: true, modifiedBy, source }`. `source` is either a
 * registered name (built-ins `http`/`cron`/`cli`/`rabbitmq`, or a custom one
 * added via `registerAuditSources()`) or a function returning one (resolved
 * at call time: `() => process.env.HISTORY_SOURCE`); an unregistered value
 * throws. Defaults to `modifiedBy: null` (system record) and `source: 'cli'`.
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
                    modifiedBy: options.modifiedBy ?? null,
                    source: resolveSource(options.source ?? 'cli'),
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
 * const KafkaAuditContext = createAuditContextDecorator({ source: 'kafka' });
 * @KafkaAuditContext({ modifiedBy })
 * async handle(msg) { ... }
 * ```
 */
export function createAuditContextDecorator(defaults: AuditContextOptions): (options?: AuditContextOptions) => MethodDecorator {
    return (options: AuditContextOptions = {}) => AuditContext({ ...defaults, ...options });
}
