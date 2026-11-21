import { Types } from 'mongoose';
import { build_record, ensure_upsert_document_id, write_history_records } from '../../src/plugin/audit_trail_plugin';
import { get_transaction_session, with_session } from '../../src/plugin/transaction';
import { resetAuditContextResolver, setAuditContextResolver } from '../../src/context/user_context';
import { AuditTrailPluginOptions, AuditRecord } from '../../src/context/types';

describe('ensure_upsert_document_id', () => {
    it('converts a plain update into operator form with an injected _id', () => {
        const update = { name: 'x' };
        const result = ensure_upsert_document_id(update);

        expect(result.document_id).toBeInstanceOf(Types.ObjectId);
        expect(result.update).toEqual({ $set: { name: 'x' }, $setOnInsert: { _id: result.document_id } });
        // the caller's object is untouched
        expect(update).toEqual({ name: 'x' });
    });

    it('generates a fresh _id on every call and never mutates the input', () => {
        const update = { name: 'x' };
        const first = ensure_upsert_document_id(update);
        const second = ensure_upsert_document_id(update);

        expect(String(first.document_id)).not.toBe(String(second.document_id));
        expect(update).toEqual({ name: 'x' });
    });

    it('keeps an explicitly provided plain _id', () => {
        const id = new Types.ObjectId();
        const update = { _id: id, name: 'x' };
        const result = ensure_upsert_document_id(update);

        expect(String(result.document_id)).toBe(String(id));
        expect(result.update).toBe(update);
    });

    it('keeps an explicitly provided $setOnInsert._id', () => {
        const id = new Types.ObjectId();
        const update = { $set: { name: 'x' }, $setOnInsert: { _id: id } };
        const result = ensure_upsert_document_id(update);

        expect(String(result.document_id)).toBe(String(id));
        expect(result.update).toBe(update);
    });

    it('merges the injected _id into an existing $setOnInsert without mutating it', () => {
        const update = { $set: { name: 'x' }, $setOnInsert: { foo: 1 } };
        const result = ensure_upsert_document_id(update);

        expect(result.document_id).toBeInstanceOf(Types.ObjectId);
        expect(result.update).toEqual({ $set: { name: 'x' }, $setOnInsert: { foo: 1, _id: result.document_id } });
        expect(update.$setOnInsert).toEqual({ foo: 1 });
    });

    it('leaves aggregation pipeline updates untouched', () => {
        const pipeline = [{ $set: { name: 'x' } }];
        const result = ensure_upsert_document_id(pipeline as any);

        expect(result).toEqual({ document_id: null, update: pipeline });
    });

    it('returns a null document_id for non-object updates', () => {
        expect(ensure_upsert_document_id(null as any)).toEqual({ document_id: null, update: null });
        expect(ensure_upsert_document_id(undefined as any)).toEqual({ document_id: null, update: undefined });
    });

    it('uses the _id from the query filter and leaves the update untouched', () => {
        const id = new Types.ObjectId();
        const update = { $set: { name: 'x' } };
        const result = ensure_upsert_document_id(update, { _id: id });

        expect(String(result.document_id)).toBe(String(id));
        expect(result.update).toBe(update);
        expect(result.update).toEqual({ $set: { name: 'x' } });
    });

    it('uses the _id from the query filter as a string', () => {
        const id = new Types.ObjectId();
        const update = { name: 'x' };
        const result = ensure_upsert_document_id(update, { _id: id.toHexString() });

        expect(String(result.document_id)).toBe(String(id));
        expect(result.update).toBe(update);
    });

    it('uses the _id from the query filter with $eq', () => {
        const id = new Types.ObjectId();
        const update = { $set: { name: 'x' } };
        const result = ensure_upsert_document_id(update, { _id: { $eq: id } });

        expect(String(result.document_id)).toBe(String(id));
        expect(result.update).toBe(update);
    });

    it('injects a fresh _id when the query filter uses a non-equality operator', () => {
        const update = { $set: { name: 'x' } };
        const result = ensure_upsert_document_id(update, { _id: { $in: [new Types.ObjectId()] } });

        expect(result.document_id).toBeInstanceOf(Types.ObjectId);
        expect(result.update).toEqual({ $set: { name: 'x' }, $setOnInsert: { _id: result.document_id } });
    });

    it('injects _id directly into a replacement document', () => {
        const update = { name: 'x' };
        const result = ensure_upsert_document_id(update, undefined, true);

        expect(result.document_id).toBeInstanceOf(Types.ObjectId);
        expect(result.update).toEqual({ name: 'x', _id: result.document_id });
        expect(update).toEqual({ name: 'x' });
    });

    it('uses the _id from the query filter for a replacement and leaves the update untouched', () => {
        const id = new Types.ObjectId();
        const update = { name: 'x' };
        const result = ensure_upsert_document_id(update, { _id: id }, true);

        expect(String(result.document_id)).toBe(String(id));
        expect(result.update).toBe(update);
        expect(result.update).toEqual({ name: 'x' });
    });

    it('uses the _id from a replacement document and leaves the update untouched', () => {
        const id = new Types.ObjectId();
        const update = { _id: id, name: 'x' };
        const result = ensure_upsert_document_id(update, undefined, true);

        expect(String(result.document_id)).toBe(String(id));
        expect(result.update).toBe(update);
    });
});

describe('session resolution helpers', () => {
    it('with_session passes the session only when defined', () => {
        const query = { session: jest.fn().mockReturnThis() };

        expect(with_session(query, undefined)).toBe(query);
        expect(query.session).not.toHaveBeenCalled();

        const session = { id: 's' } as any;
        expect(with_session(query, session)).toBe(query);
        expect(query.session).toHaveBeenCalledWith(session);
    });

    it('get_transaction_session reads the mongoose transactionAsyncLocalStorage store', () => {
        const session = { id: 's' };
        const model = { db: { base: { transactionAsyncLocalStorage: { getStore: () => ({ session }) } } } };

        expect(get_transaction_session(model)).toBe(session);
    });

    it('get_transaction_session returns undefined without an active store', () => {
        expect(get_transaction_session({})).toBeUndefined();
        expect(get_transaction_session(undefined)).toBeUndefined();
    });
});

describe('build_record (source and modified_by)', () => {
    const options: AuditTrailPluginOptions = { historyCollectionName: 'history' };

    afterEach(() => {
        resetAuditContextResolver();
    });

    it('defaults source to http and modified_by to null without context', () => {
        const record = build_record('col', 'Model', new Types.ObjectId(), 'created', 'save', {}, options);

        expect(record.source).toBe('http');
        expect(record.modified_by).toBeNull();
    });

    it('takes source and modified_by from the context', () => {
        const modifiedBy = new Types.ObjectId();
        setAuditContextResolver(() => ({ enabled: true, modifiedBy, source: 'cron' }));

        const record = build_record('col', 'Model', new Types.ObjectId(), 'updated', 'updateMany', {}, options);

        expect(record.source).toBe('cron');
        expect(record.modified_by).toBe(modifiedBy);
    });

    it('throws when the resolver supplies an unregistered source', () => {
        setAuditContextResolver(() => ({ enabled: true, source: 'kafka' }));

        expect(() => build_record('col', 'Model', new Types.ObjectId(), 'updated', 'updateMany', {}, options)).toThrow(
            /registerAuditSources/,
        );
    });
});

describe('write_history_records (session and error policy)', () => {
    const options: AuditTrailPluginOptions = { historyCollectionName: 'history' };
    const record = { collection_name: 'col', action: 'updated', method: 'updateMany', document_id: new Types.ObjectId() } as AuditRecord;

    function mockModel() {
        const insertOne = jest.fn().mockResolvedValue({});
        const insertMany = jest.fn().mockResolvedValue({});
        return { model: { db: { collection: () => ({ insertOne, insertMany }) }, modelName: 'TestModel' }, insertOne, insertMany };
    }

    it('inserts one record via insertOne and passes the session', async () => {
        const { model, insertOne, insertMany } = mockModel();
        const session = { id: 's' } as any;

        await write_history_records(model, options, [record], session);

        expect(insertOne).toHaveBeenCalledWith(record, { session });
        expect(insertMany).not.toHaveBeenCalled();
    });

    it('inserts without write options when there is no session', async () => {
        const { model, insertOne } = mockModel();

        await write_history_records(model, options, [record]);

        expect(insertOne).toHaveBeenCalledWith(record, undefined);
    });

    it('inserts multiple records via insertMany', async () => {
        const { model, insertMany } = mockModel();

        await write_history_records(model, options, [record, record]);

        expect(insertMany).toHaveBeenCalledWith([record, record], undefined);
    });

    it('does nothing for an empty record list', async () => {
        const { model, insertOne, insertMany } = mockModel();

        await write_history_records(model, options, []);

        expect(insertOne).not.toHaveBeenCalled();
        expect(insertMany).not.toHaveBeenCalled();
    });

    it('logs the insert error and rethrows it when a transaction is active', async () => {
        const { model, insertOne } = mockModel();
        insertOne.mockRejectedValue(new Error('insert failed'));
        const error = jest.fn();

        await expect(
            write_history_records(model, { ...options, logger: { error } }, [record], { inTransaction: () => true } as any),
        ).rejects.toThrow('insert failed');
        expect(error).toHaveBeenCalledWith(expect.stringContaining('aborting the transaction'), expect.any(Error));
    });

    it('swallows and logs the error for a session outside a transaction', async () => {
        const { model, insertOne } = mockModel();
        insertOne.mockRejectedValue(new Error('insert failed'));
        const error = jest.fn();

        await write_history_records(model, { ...options, logger: { error } }, [record], { inTransaction: () => false } as any);

        expect(error).toHaveBeenCalledWith(expect.stringContaining('history record is LOST'), expect.any(Error));
    });

    it('swallows the insert error and logs it without a session', async () => {
        const { model, insertOne } = mockModel();
        insertOne.mockRejectedValue(new Error('insert failed'));
        const error = jest.fn();
        const withLogger = { ...options, logger: { error } };

        await write_history_records(model, withLogger, [record]);

        expect(error).toHaveBeenCalledWith(expect.stringContaining('history record is LOST'), expect.any(Error));
    });

    it('names the lost records in the log message', async () => {
        const { model, insertOne } = mockModel();
        insertOne.mockRejectedValue(new Error('insert failed'));
        const error = jest.fn();

        await write_history_records(model, { ...options, logger: { error } }, [record]);

        const message = error.mock.calls[0][0] as string;
        expect(message).toContain('1 history record(s) for TestModel into history');
        expect(message).toContain('method: updateMany');
        expect(message).toContain('actions: updated');
        expect(message).toContain(String(record.document_id));
    });

    it('logs to stderr when no logger is provided', async () => {
        const { model, insertOne } = mockModel();
        insertOne.mockRejectedValue(new Error('insert failed'));
        const write = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);

        try {
            await write_history_records(model, options, [record]);

            expect(write).toHaveBeenCalledWith(expect.stringContaining('history record is LOST'));
            expect(write).toHaveBeenCalledWith(expect.stringContaining('insert failed'));
        } finally {
            write.mockRestore();
        }
    });

    it('logs the same error object only once', async () => {
        const { model, insertOne } = mockModel();
        const failure = new Error('insert failed');
        insertOne.mockRejectedValue(failure);
        const error = jest.fn();

        await write_history_records(model, { ...options, logger: { error } }, [record]);
        await write_history_records(model, { ...options, logger: { error } }, [record]);

        expect(error).toHaveBeenCalledTimes(1);
    });

    it('logs a frozen error object without throwing', async () => {
        const { model, insertOne } = mockModel();
        insertOne.mockRejectedValue(Object.freeze(new Error('insert failed')));
        const error = jest.fn();

        await write_history_records(model, { ...options, logger: { error } }, [record]);

        expect(error).toHaveBeenCalledWith(expect.stringContaining('history record is LOST'), expect.any(Error));
    });
});
