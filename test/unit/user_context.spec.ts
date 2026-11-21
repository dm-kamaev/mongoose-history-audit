import { Types } from 'mongoose';
import {
    getAuditContext,
    getAuditInitiator,
    getAuditUserId,
    isAuditEnabled,
    resetAuditContextResolver,
    runWithAuditContext,
    setAuditContextResolver,
    withHistoryUser,
    registerAuditInitiators,
    resetAuditInitiators,
    isKnownInitiator,
    resolveInitiator,
} from '../../src/context/user_context';
import { AuditInitiator } from '../../src/context/types';

describe('user_context (audit context resolver)', () => {
    afterEach(() => {
        resetAuditContextResolver();
        resetAuditInitiators();
    });

    it('is disabled and has null userId when no resolver is registered', () => {
        expect(getAuditContext()).toBeUndefined();
        expect(isAuditEnabled()).toBe(false);
        expect(getAuditUserId()).toBeNull();
    });

    it('reads context from the registered resolver', () => {
        const userId = new Types.ObjectId('64e5faee64e5faee64e5faee');
        setAuditContextResolver(() => ({ enabled: true, userId }));
        expect(getAuditContext()).toEqual({ enabled: true, userId });
        expect(isAuditEnabled()).toBe(true);
        expect(getAuditUserId()).toBe(userId);
    });

    it('converts a valid ObjectId string userId to ObjectId', () => {
        const hex = '64e5faee64e5faee64e5faee';
        setAuditContextResolver(() => ({ enabled: true, userId: hex }));
        expect(getAuditUserId()).toBeInstanceOf(Types.ObjectId);
        expect(String(getAuditUserId())).toBe(hex);
    });

    it('treats an invalid string userId as null (system record)', () => {
        setAuditContextResolver(() => ({ enabled: true, userId: 'not-an-object-id' }));
        expect(getAuditUserId()).toBeNull();
    });

    it('treats a resolver returning undefined as disabled', () => {
        setAuditContextResolver(() => undefined);
        expect(isAuditEnabled()).toBe(false);
        expect(getAuditUserId()).toBeNull();
    });

    it('treats a throwing resolver as disabled', () => {
        setAuditContextResolver(() => {
            throw new Error('boom');
        });
        expect(isAuditEnabled()).toBe(false);
        expect(getAuditUserId()).toBeNull();
    });

    it('resetAuditContextResolver removes the resolver', () => {
        setAuditContextResolver(() => ({ enabled: true }));
        resetAuditContextResolver();
        expect(isAuditEnabled()).toBe(false);
    });

    it('has no initiator when the context does not set one', () => {
        setAuditContextResolver(() => ({ enabled: true }));
        expect(getAuditInitiator()).toBeUndefined();
    });

    it('reads initiator from the registered resolver', () => {
        setAuditContextResolver(() => ({ enabled: true, initiator: AuditInitiator.cli }));
        expect(getAuditInitiator()).toBe('cli');
    });

    it('accepts an unregistered custom initiator string', () => {
        setAuditContextResolver(() => ({ enabled: true, initiator: 'kafka' }));
        expect(getAuditInitiator()).toBe('kafka');
    });

    it('has no initiator without a resolver', () => {
        expect(getAuditInitiator()).toBeUndefined();
    });

    it('setAuditContextResolver returns the previously registered resolver', () => {
        const first = () => ({ enabled: true });
        setAuditContextResolver(first);
        expect(setAuditContextResolver(() => ({ enabled: false }))).toBe(first);
    });

    it('runWithAuditContext applies the context and leaves the resolver for calls outside the scope', async () => {
        setAuditContextResolver(() => ({ enabled: false }));

        const result = await runWithAuditContext({ enabled: true, userId: null, initiator: AuditInitiator.cron }, async () => {
            expect(isAuditEnabled()).toBe(true);
            expect(getAuditInitiator()).toBe('cron');
            expect(getAuditUserId()).toBeNull();
            return 'done';
        });

        expect(result).toBe('done');
        expect(isAuditEnabled()).toBe(false);
    });

    it('runWithAuditContext does not leak the context when the callback throws', async () => {
        setAuditContextResolver(() => ({ enabled: false }));

        await expect(
            runWithAuditContext({ enabled: true, initiator: AuditInitiator.cli }, async () => {
                throw new Error('boom');
            }),
        ).rejects.toThrow('boom');

        expect(isAuditEnabled()).toBe(false);
    });

    it('runWithAuditContext isolates overlapping calls and does not swap the resolver', async () => {
        setAuditContextResolver(() => ({ enabled: true, initiator: AuditInitiator.http }));

        let release_a!: () => void;
        let release_b!: () => void;
        const gate_a = new Promise<void>(resolve => (release_a = resolve));
        const gate_b = new Promise<void>(resolve => (release_b = resolve));

        const a = runWithAuditContext({ enabled: true, initiator: AuditInitiator.cron }, async () => {
            await gate_a;
            return getAuditInitiator();
        });
        const b = runWithAuditContext({ enabled: true, initiator: AuditInitiator.cli }, async () => {
            await gate_b;
            return getAuditInitiator();
        });

        release_a();
        release_b();

        expect(await a).toBe('cron');
        expect(await b).toBe('cli');
        expect(getAuditInitiator()).toBe('http');
    });

    it('withHistoryUser pins the userId (person who changed the data)', async () => {
        const user_a = new Types.ObjectId();
        const user_b = new Types.ObjectId();

        await withHistoryUser(user_a, async () => {
            expect(getAuditUserId()).toBe(user_a);
        });
        await withHistoryUser(user_b, async () => {
            expect(getAuditUserId()).toBe(user_b);
        });

        expect(getAuditUserId()).toBeNull();
    });

    it('withHistoryUser keeps the ambient initiator and re-enables the context', async () => {
        setAuditContextResolver(() => ({ enabled: false, initiator: AuditInitiator.http }));

        await withHistoryUser(new Types.ObjectId(), async () => {
            expect(isAuditEnabled()).toBe(true);
            expect(getAuditInitiator()).toBe('http');
        });

        expect(isAuditEnabled()).toBe(false);
    });

    it('withHistoryUser defaults initiator to cli outside any scope', async () => {
        await withHistoryUser(null, async () => {
            expect(getAuditInitiator()).toBe('cli');
        });
    });
});

describe('initiator registry', () => {
    afterEach(() => {
        resetAuditInitiators();
    });

    it('knows the four built-in initiators', () => {
        for (const name of ['http', 'cron', 'cli', 'rabbitmq']) {
            expect(isKnownInitiator(name)).toBe(true);
        }
    });

    it('does not know unregistered custom initiators', () => {
        expect(isKnownInitiator('kafka')).toBe(false);
    });

    it('registerAuditInitiators adds names', () => {
        registerAuditInitiators('kafka', 'grpc');
        expect(isKnownInitiator('kafka')).toBe(true);
        expect(isKnownInitiator('grpc')).toBe(true);
    });

    it('registerAuditInitiators is additive and ignores empty names', () => {
        registerAuditInitiators('kafka');
        registerAuditInitiators('grpc', '');
        expect(isKnownInitiator('kafka')).toBe(true);
        expect(isKnownInitiator('grpc')).toBe(true);
        expect(isKnownInitiator('http')).toBe(true);
    });

    it('resetAuditInitiators restores only the built-ins', () => {
        registerAuditInitiators('kafka');
        resetAuditInitiators();
        expect(isKnownInitiator('kafka')).toBe(false);
        expect(isKnownInitiator('http')).toBe(true);
    });

    describe('resolveInitiator', () => {
        it('resolves a thunk at call time', () => {
            expect(resolveInitiator(() => 'kafka')).toBe('kafka');
        });

        it('returns cli for undefined/null', () => {
            expect(resolveInitiator(undefined as any)).toBe('cli');
            expect(resolveInitiator(null as any)).toBe('cli');
            expect(resolveInitiator(() => undefined)).toBe('cli');
        });

        it('keeps an unregistered value but warns through the logger', () => {
            const warn = jest.fn();
            expect(resolveInitiator('kafka', { error: jest.fn(), warn })).toBe('kafka');
            expect(warn).toHaveBeenCalledWith(expect.stringContaining('kafka'));
            expect(warn).toHaveBeenCalledWith(expect.stringContaining('registerAuditInitiators'));
        });

        it('does not warn for a registered value', () => {
            const warn = jest.fn();
            registerAuditInitiators('kafka');
            expect(resolveInitiator('kafka', { error: jest.fn(), warn })).toBe('kafka');
            expect(warn).not.toHaveBeenCalled();
        });

        it('does not warn for built-in values', () => {
            const warn = jest.fn();
            expect(resolveInitiator(AuditInitiator.cron, { error: jest.fn(), warn })).toBe('cron');
            expect(warn).not.toHaveBeenCalled();
        });

        it('does not warn when no logger is given', () => {
            expect(resolveInitiator('kafka')).toBe('kafka');
        });
    });
});
