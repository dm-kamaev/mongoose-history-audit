import { Types } from 'mongoose';
import { AuditError } from '../../src/context/errors';
import {
    getAuditContext,
    getAuditSource,
    getAuditModifiedBy,
    isAuditEnabled,
    resetAuditContextResolver,
    runWithAuditContext,
    setAuditContextResolver,
    registerAuditSources,
    resetAuditSources,
    isKnownSource,
    resolveSource,
} from '../../src/context/user_context';

describe('user_context (audit context resolver)', () => {
    afterEach(() => {
        resetAuditContextResolver();
        resetAuditSources();
    });

    it('is disabled and has null modifiedBy when no resolver is registered', () => {
        expect(getAuditContext()).toBeUndefined();
        expect(isAuditEnabled()).toBe(false);
        expect(getAuditModifiedBy()).toBeNull();
    });

    it('reads context from the registered resolver', () => {
        const modifiedBy = new Types.ObjectId('64e5faee64e5faee64e5faee');
        setAuditContextResolver(() => ({ enabled: true, modifiedBy }));
        expect(getAuditContext()).toEqual({ enabled: true, modifiedBy });
        expect(isAuditEnabled()).toBe(true);
        expect(getAuditModifiedBy()).toBe(modifiedBy);
    });

    it('converts a valid ObjectId string in modifiedBy to ObjectId', () => {
        const hex = '64e5faee64e5faee64e5faee';
        setAuditContextResolver(() => ({ enabled: true, modifiedBy: hex }));
        expect(getAuditModifiedBy()).toBeInstanceOf(Types.ObjectId);
        expect(String(getAuditModifiedBy())).toBe(hex);
    });

    it('treats an invalid string modifiedBy as null (system record)', () => {
        setAuditContextResolver(() => ({ enabled: true, modifiedBy: 'not-an-object-id' }));
        expect(getAuditModifiedBy()).toBeNull();
    });

    it('treats a resolver returning undefined as disabled', () => {
        setAuditContextResolver(() => undefined);
        expect(isAuditEnabled()).toBe(false);
        expect(getAuditModifiedBy()).toBeNull();
    });

    it('treats a throwing resolver as disabled', () => {
        setAuditContextResolver(() => {
            throw new Error('boom');
        });
        expect(isAuditEnabled()).toBe(false);
        expect(getAuditModifiedBy()).toBeNull();
    });

    it('resetAuditContextResolver removes the resolver', () => {
        setAuditContextResolver(() => ({ enabled: true }));
        resetAuditContextResolver();
        expect(isAuditEnabled()).toBe(false);
    });

    it('has no source when the context does not set one', () => {
        setAuditContextResolver(() => ({ enabled: true }));
        expect(getAuditSource()).toBeUndefined();
    });

    it('reads source from the registered resolver', () => {
        setAuditContextResolver(() => ({ enabled: true, source: 'cli' }));
        expect(getAuditSource()).toBe('cli');
    });

    it('accepts an unregistered custom source string', () => {
        setAuditContextResolver(() => ({ enabled: true, source: 'kafka' }));
        expect(getAuditSource()).toBe('kafka');
    });

    it('has no source without a resolver', () => {
        expect(getAuditSource()).toBeUndefined();
    });

    it('setAuditContextResolver returns the previously registered resolver', () => {
        const first = () => ({ enabled: true });
        setAuditContextResolver(first);
        expect(setAuditContextResolver(() => ({ enabled: false }))).toBe(first);
    });

    it('runWithAuditContext applies the context and leaves the resolver for calls outside the scope', async () => {
        setAuditContextResolver(() => ({ enabled: false }));

        const result = await runWithAuditContext({ enabled: true, modifiedBy: null, source: 'cron' }, async () => {
            expect(isAuditEnabled()).toBe(true);
            expect(getAuditSource()).toBe('cron');
            expect(getAuditModifiedBy()).toBeNull();
            return 'done';
        });

        expect(result).toBe('done');
        expect(isAuditEnabled()).toBe(false);
    });

    it('runWithAuditContext does not leak the context when the callback throws', async () => {
        setAuditContextResolver(() => ({ enabled: false }));

        await expect(
            runWithAuditContext({ enabled: true, source: 'cli' }, async () => {
                throw new Error('boom');
            }),
        ).rejects.toThrow('boom');

        expect(isAuditEnabled()).toBe(false);
    });

    it('runWithAuditContext throws for an unregistered source', () => {
        expect(() => runWithAuditContext({ enabled: true, source: 'kafka' }, () => undefined)).toThrow(/registerAuditSources/);
    });

    it('runWithAuditContext isolates overlapping calls and does not swap the resolver', async () => {
        setAuditContextResolver(() => ({ enabled: true, source: 'http' }));

        let release_a!: () => void;
        let release_b!: () => void;
        const gate_a = new Promise<void>(resolve => (release_a = resolve));
        const gate_b = new Promise<void>(resolve => (release_b = resolve));

        const a = runWithAuditContext({ enabled: true, source: 'cron' }, async () => {
            await gate_a;
            return getAuditSource();
        });
        const b = runWithAuditContext({ enabled: true, source: 'cli' }, async () => {
            await gate_b;
            return getAuditSource();
        });

        release_a();
        release_b();

        expect(await a).toBe('cron');
        expect(await b).toBe('cli');
        expect(getAuditSource()).toBe('http');
    });
});

describe('source registry', () => {
    afterEach(() => {
        resetAuditSources();
    });

    it('knows the four built-in sources', () => {
        for (const name of ['http', 'cron', 'cli', 'rabbitmq']) {
            expect(isKnownSource(name)).toBe(true);
        }
    });

    it('does not know unregistered custom sources', () => {
        expect(isKnownSource('kafka')).toBe(false);
    });

    it('registerAuditSources adds names', () => {
        registerAuditSources('kafka', 'grpc');
        expect(isKnownSource('kafka')).toBe(true);
        expect(isKnownSource('grpc')).toBe(true);
    });

    it('registerAuditSources is additive and ignores empty names', () => {
        registerAuditSources('kafka');
        registerAuditSources('grpc', '');
        expect(isKnownSource('kafka')).toBe(true);
        expect(isKnownSource('grpc')).toBe(true);
        expect(isKnownSource('http')).toBe(true);
    });

    it('resetAuditSources restores only the built-ins', () => {
        registerAuditSources('kafka');
        resetAuditSources();
        expect(isKnownSource('kafka')).toBe(false);
        expect(isKnownSource('http')).toBe(true);
    });

    describe('resolveSource', () => {
        it('resolves a thunk at call time', () => {
            registerAuditSources('kafka');
            expect(resolveSource(() => 'kafka')).toBe('kafka');
            expect(resolveSource(() => 'cron')).toBe('cron');
        });

        it('returns cli for undefined/null', () => {
            expect(resolveSource(undefined as any)).toBe('cli');
            expect(resolveSource(null as any)).toBe('cli');
            expect(resolveSource(() => undefined)).toBe('cli');
        });

        it('throws for an unregistered value', () => {
            expect(() => resolveSource('kafka')).toThrow(AuditError);
            expect(() => resolveSource('kafka')).toThrow('Unknown audit source "kafka"');
            expect(() => resolveSource('kafka')).toThrow('registerAuditSources');
        });

        it('accepts a registered value', () => {
            registerAuditSources('kafka');
            expect(resolveSource('kafka')).toBe('kafka');
        });

        it('accepts built-in values', () => {
            expect(resolveSource('cron')).toBe('cron');
        });
    });
});
