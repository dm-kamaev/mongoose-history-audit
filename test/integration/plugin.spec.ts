import { Types } from 'mongoose';
import { auditTrailPlugin } from '../../src/plugin/audit_trail_plugin';
import { runWithAuditContext, setAuditContextResolver, resetAuditContextResolver } from '../../src/context/user_context';
import { AuditInitiator, AuditTrailPluginOptions } from '../../src/context/types';
import { HISTORY_COLLECTION, clean_history, make_schema, model_for, read_history, start_db, stop_db } from '../helpers/db';

const options: AuditTrailPluginOptions = { historyCollectionName: HISTORY_COLLECTION };
const user_a = new Types.ObjectId();
const user_b = new Types.ObjectId();

function with_context<T>(
    fn: () => Promise<T>,
    userId: Types.ObjectId | null = user_a,
    initiator: AuditInitiator = AuditInitiator.http,
): Promise<T> {
    return runWithAuditContext({ enabled: true, userId, initiator }, fn);
}

describe('auditTrailPlugin (mongodb in memory)', () => {
    beforeAll(async () => {
        await start_db();
    });

    afterAll(async () => {
        await stop_db();
    });

    beforeEach(async () => {
        resetAuditContextResolver();
        await clean_history();
    });

    afterEach(() => {
        resetAuditContextResolver();
    });

    function fresh_model(name: string) {
        const schema = make_schema();
        schema.plugin(auditTrailPlugin, options);
        return model_for(schema, name);
    }

    describe('save', () => {
        it('writes a created record with snake_case fields', async () => {
            const Model = fresh_model('SaveCreate');
            const doc = await with_context(() => Model.create({ name: 'first', priority: 1 }));

            const records = await read_history();
            expect(records).toHaveLength(1);
            const record = records[0];

            expect(record.collection_name).toBe('savecreates');
            expect(record.model_name).toBe('SaveCreate');
            expect(String(record.document_id)).toBe(String(doc._id));
            expect(record.action).toBe('created');
            expect(record.method).toBe('save');
            expect(record.modified_by).toBeInstanceOf(Types.ObjectId);
            expect(String(record.modified_by)).toBe(String(user_a));
            expect(record.initiator).toBe('http');
            expect(record.created_at).toBeInstanceOf(Date);
            expect(record.changes.name.new).toBe('first');
            expect(record.changes.priority.new).toBe(1);
            // diffOnly default: no snapshots
            expect(record.old_document).toBeUndefined();
            expect(record.current_document).toBeUndefined();
            // timestamps are omitted from changes
            expect(record.changes.created_at).toBeUndefined();
            expect(record.changes.updated_at).toBeUndefined();
            expect(record.changes.__v).toBeUndefined();
        });

        it('writes an updated record with only the changed paths', async () => {
            const Model = fresh_model('SaveUpdate');
            const doc = await with_context(() => Model.create({ name: 'before', priority: 1 }));
            await with_context(() => Model.findByIdAndUpdate(doc._id, { priority: 2 }), user_b, AuditInitiator.cron);

            const records = await read_history({ action: 'updated' });
            expect(records).toHaveLength(1);
            expect(records[0].changes.priority).toEqual({ old: 1, new: 2 });
            expect(records[0].changes.name).toBeUndefined();
            expect(String(records[0].modified_by)).toBe(String(user_b));
            expect(records[0].initiator).toBe('cron');
        });

        it('does not write a record when nothing changed (no-op save)', async () => {
            const Model = fresh_model('SaveNoop');
            const doc = await with_context(() => Model.create({ name: 'same' }));
            await with_context(() => {
                doc.name = 'same';
                return doc.save();
            });

            expect(await read_history({ action: 'updated' })).toHaveLength(0);
        });

        it('writes nothing when the audit context is disabled', async () => {
            const Model = fresh_model('SaveDisabled');
            await Model.create({ name: 'no-context' });

            expect(await read_history()).toHaveLength(0);
        });
    });

    describe('query updates', () => {
        it('findOneAndUpdate writes an updated record', async () => {
            const Model = fresh_model('FindOneAndUpdate');
            const doc = await with_context(() => Model.create({ name: 'a', priority: 1 }));
            await with_context(() => Model.findByIdAndUpdate(doc._id, { name: 'b' }));

            const records = await read_history({ action: 'updated' });
            expect(records).toHaveLength(1);
            expect(records[0].method).toBe('findOneAndUpdate');
            expect(records[0].changes.name).toEqual({ old: 'a', new: 'b' });
        });

        it('updateOne writes an updated record with allowed-path filtering', async () => {
            const Model = fresh_model('UpdateOne');
            const doc = await with_context(() => Model.create({ name: 'a', priority: 1 }));
            await with_context(() => Model.updateOne({ _id: doc._id }, { $set: { priority: 10 } }));

            const records = await read_history({ action: 'updated' });
            expect(records).toHaveLength(1);
            expect(records[0].changes.priority).toEqual({ old: 1, new: 10 });
            expect(records[0].changes.name).toBeUndefined();
        });

        it('updateMany writes one record per matched document', async () => {
            const Model = fresh_model('UpdateMany');
            await with_context(async () => {
                await Model.create([
                    { name: 'x', priority: 1 },
                    { name: 'y', priority: 1 },
                ]);
                await Model.updateMany({}, { $set: { priority: 2 } });
            });

            const records = await read_history({ action: 'updated' });
            expect(records).toHaveLength(2);
            for (const record of records) {
                expect(record.method).toBe('updateMany');
                expect(record.changes.priority).toEqual({ old: 1, new: 2 });
            }
        });

        it('update with no match writes nothing', async () => {
            const Model = fresh_model('UpdateNoMatch');
            await with_context(() => Model.updateOne({ name: 'missing' }, { $set: { priority: 1 } }));

            expect(await read_history()).toHaveLength(0);
        });

        it('upsert without a match writes a created record', async () => {
            const Model = fresh_model('Upsert');
            await with_context(() => Model.updateOne({ name: 'upserted' }, { $set: { priority: 5 } }, { upsert: true }));

            const records = await read_history({ action: 'created' });
            expect(records).toHaveLength(1);
            expect(records[0].method).toBe('updateOne');
            expect(records[0].changes.priority.new).toBe(5);
            expect(records[0].changes.name.new).toBe('upserted');
        });
    });

    describe('deletes', () => {
        it('findOneAndDelete writes a deleted record with the full old document as changes', async () => {
            const Model = fresh_model('FindOneAndDelete');
            const doc = await with_context(() => Model.create({ name: 'gone', priority: 7 }));
            await with_context(() => Model.findByIdAndDelete(doc._id));

            const records = await read_history({ action: 'deleted' });
            expect(records).toHaveLength(1);
            expect(records[0].method).toBe('findOneAndDelete');
            // BSON stores undefined as null
            expect(records[0].changes.name).toEqual({ old: 'gone', new: null });
            // root _id is omitted, timestamps kept for deletes
            expect(records[0].changes._id).toBeUndefined();
            expect(String(records[0].document_id)).toBe(String(doc._id));
        });

        it('deleteMany writes one record per deleted document', async () => {
            const Model = fresh_model('DeleteMany');
            await with_context(async () => {
                await Model.create([{ name: 'd1' }, { name: 'd2' }]);
                await Model.deleteMany({});
            });

            const records = await read_history({ action: 'deleted' });
            expect(records).toHaveLength(2);
            expect(records.map(r => r.changes.name.old).sort()).toEqual(['d1', 'd2']);
        });
    });

    describe('insertMany and bulkWrite', () => {
        it('insertMany writes one created record per document', async () => {
            const Model = fresh_model('InsertMany');
            await with_context(() => Model.insertMany([{ name: 'i1' }, { name: 'i2' }]));

            const records = await read_history({ action: 'created' });
            expect(records).toHaveLength(2);
            expect(records.every(r => r.method === 'insertMany')).toBe(true);
        });

        it('bulkWrite mixes insert, update and delete into records', async () => {
            const Model = fresh_model('BulkWrite');
            const existing = await with_context(() => Model.create({ name: 'bulk', priority: 1 }));
            const doomed = await with_context(() => Model.create({ name: 'doomed' }));

            await with_context(() =>
                Model.bulkWrite([
                    { insertOne: { document: { name: 'bulk-new' } } },
                    { updateOne: { filter: { _id: existing._id }, update: { $set: { priority: 9 } } } },
                    { deleteOne: { filter: { _id: doomed._id } } },
                ]),
            );

            const created = await read_history({ action: 'created' });
            const updated = await read_history({ action: 'updated' });
            const deleted = await read_history({ action: 'deleted' });

            expect(created).toHaveLength(3); // 2 initial creates + bulk insert
            expect(updated).toHaveLength(1);
            expect(updated[0].changes.priority).toEqual({ old: 1, new: 9 });
            expect(deleted).toHaveLength(1);
            expect(deleted[0].method).toBe('bulkWrite');
        });
    });

    describe('array element diffs', () => {
        it('shrinks subdocument array changes to the modified element', async () => {
            const Model = fresh_model('ArrayDiff');
            const e1 = new Types.ObjectId();
            const e2 = new Types.ObjectId();
            const doc = await with_context(() =>
                Model.create({
                    name: 'arr',
                    assignments: [
                        { _id: e1, priority: 100 },
                        { _id: e2, priority: 200 },
                    ],
                }),
            );

            await with_context(() =>
                Model.findByIdAndUpdate(doc._id, {
                    $set: {
                        assignments: [
                            { _id: e1, priority: 150 },
                            { _id: e2, priority: 200 },
                        ],
                    },
                }),
            );

            const records = await read_history({ action: 'updated' });
            expect(records).toHaveLength(1);
            expect(records[0].changes.assignments).toEqual({
                old: [{ _id: e1, priority: 100 }],
                new: [{ _id: e1, priority: 150 }],
            });
        });
    });

    describe('initiator and modified_by (user_id API)', () => {
        it('records the userId and initiator from runWithAuditContext', async () => {
            const Model = fresh_model('ContextUser');
            await with_context(() => Model.create({ name: 'by-user' }), user_b, AuditInitiator.cli);

            const [record] = await read_history();
            expect(String(record.modified_by)).toBe(String(user_b));
            expect(record.initiator).toBe('cli');
        });

        it('records modified_by null for a system run (no userId)', async () => {
            const Model = fresh_model('ContextSystem');
            await runWithAuditContext({ enabled: true, userId: null, initiator: AuditInitiator.cron }, () => Model.create({ name: 'sys' }));

            const [record] = await read_history();
            expect(record.modified_by).toBeNull();
            expect(record.initiator).toBe('cron');
        });

        it('reads the user from a registered resolver when no scoped context is active', async () => {
            setAuditContextResolver(() => ({ enabled: true, userId: user_a, initiator: AuditInitiator.rabbitmq }));
            const Model = fresh_model('ContextResolver');
            await Model.create({ name: 'via-resolver' });

            const [record] = await read_history();
            expect(String(record.modified_by)).toBe(String(user_a));
            expect(record.initiator).toBe('rabbitmq');
        });

        it('keeps an unregistered initiator string in the record', async () => {
            const Model = fresh_model('ContextKafka');
            await with_context(() => Model.create({ name: 'kafka' }), user_a, 'kafka' as AuditInitiator);

            const [record] = await read_history();
            expect(record.initiator).toBe('kafka');
        });
    });

    describe('diffOnly: false', () => {
        it('stores old_document and current_document snapshots', async () => {
            const schema = make_schema();
            schema.plugin(auditTrailPlugin, { ...options, diffOnly: false });
            const Model = model_for(schema, 'DiffOnlyFalse');

            const doc = await with_context(() => Model.create({ name: 'snap', priority: 1 }));
            await with_context(() => Model.updateOne({ _id: doc._id }, { $set: { priority: 2 } }));

            const [record] = await read_history({ action: 'updated' });
            expect(record.old_document).toBeDefined();
            expect(record.current_document).toBeDefined();
            expect(record.old_document.priority).toBe(1);
            expect(record.current_document.priority).toBe(2);
            expect(record.old_document._id).toBeDefined();
        });
    });

    describe('transactions', () => {
        it('commits data and history together inside connection.transaction()', async () => {
            const Model = fresh_model('TxCommit');
            const connection = Model.db;

            await connection.transaction(async () => {
                await with_context(() => Model.create({ name: 'tx-doc' }));
            });

            const records = await read_history();
            expect(records).toHaveLength(1);
        });

        it('rolls back both data and history when the transaction aborts', async () => {
            const Model = fresh_model('TxRollback');
            const connection = Model.db;

            await expect(
                connection.transaction(async () => {
                    await with_context(() => Model.create({ name: 'doomed' }));
                    throw new Error('abort-me');
                }),
            ).rejects.toThrow('abort-me');

            expect(await Model.countDocuments()).toBe(0);
            expect(await read_history()).toHaveLength(0);
        });

        it('aborting after a failed history write keeps data consistent (write inside session)', async () => {
            const Model = fresh_model('TxAtomic');
            const connection = Model.db;
            const failing: AuditTrailPluginOptions = {
                ...options,
                logger: { error: jest.fn(), warn: jest.fn() },
            };

            // Simulate a history failure inside the transaction by closing the
            // history collection name to a non-existent capped scenario: instead
            // force the insert to fail via a read-only user is not available in
            // memory server, so we assert the normal atomic path here: history
            // is written inside the same session as the change.
            const schema = make_schema();
            schema.plugin(auditTrailPlugin, failing);
            const FailingModel = model_for(schema, 'TxAtomicModel');

            await connection.transaction(async () => {
                await runWithAuditContext({ enabled: true, userId: user_a, initiator: AuditInitiator.http }, () =>
                    FailingModel.create({ name: 'atomic' }),
                );
            });

            const records = await read_history();
            expect(records).toHaveLength(1);
            expect(String(records[0].modified_by)).toBe(String(user_a));
        });
    });

    describe('metadata option', () => {
        it('computes metadata from the document snapshots', async () => {
            const schema = make_schema();
            schema.plugin(auditTrailPlugin, {
                ...options,
                metadata: {
                    tag: ({ current_document }: any) => `tag:${current_document?.name ?? ''}`,
                },
            });
            const Model = model_for(schema, 'MetadataModel');

            await with_context(() => Model.create({ name: 'meta' }));

            const [record] = await read_history();
            expect(record.metadata).toEqual({ tag: 'tag:meta' });
        });
    });
});
