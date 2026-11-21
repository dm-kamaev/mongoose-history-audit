import { Schema, Types, ClientSession } from 'mongoose';
import { AuditTrailPluginOptions, AuditRecord } from '../context/types';
import { AuditError } from '../context/errors';
import { deep_diff } from './deep_diff';
import { has_only_plain_fields, collect_update_paths, filter_changes_by_paths } from './helpers';
import { isAuditEnabled, getAuditModifiedBy, getAuditSource } from '../context/user_context';
import { get_transaction_session, with_session } from './transaction';
import { build_record, write_history_records, handle_history_error, log_history_warning, get_omit_paths } from './record';

function get_equality_id(query?: Record<string, any>): any {
    const id = query?._id;
    if (id === null || id === undefined) {
        return undefined;
    }

    // Direct equality: { _id: ObjectId('...') } or { _id: '...' }.
    if (typeof id === 'string' || Types.ObjectId.isValid(id)) {
        return id;
    }

    // { _id: { $eq: ... } } is also a single-value equality.
    if (typeof id === 'object' && !Array.isArray(id) && id.$eq !== null && id.$eq !== undefined) {
        return id.$eq;
    }

    // $in, $ne, etc. are not equality filters.
    return undefined;
}

export function ensure_upsert_document_id(
    update: Record<string, any>,
    query?: Record<string, any>,
    is_replacement?: boolean,
): {
    document_id: Types.ObjectId | null;
    update: Record<string, any>;
} {
    // Pipeline (Array) and non-object updates cannot carry an injected `_id`.
    if (!update || typeof update !== 'object' || Array.isArray(update)) {
        return { document_id: null, update };
    }

    // If the filter pins `_id` to a single value, MongoDB uses it for the
    // upserted document. Injecting another `_id` would hit the immutable `_id`
    // field (ImmutableField) or, for replacements, produce a duplicate `_id`.
    const query_id = get_equality_id(query);
    if (query_id !== null && query_id !== undefined) {
        return { document_id: new Types.ObjectId(query_id), update };
    }

    const existing_id = update._id ?? update.$set?._id ?? update.$setOnInsert?._id;
    if (existing_id !== null && existing_id !== undefined) {
        return { document_id: new Types.ObjectId(existing_id), update };
    }

    // Generate a fresh id on every call and never mutate the caller's update:
    // mutating it would persist the injected `_id`, so a reused update object
    // would insert a second document with the same `_id` (E11000).
    const document_id = new Types.ObjectId();

    if (is_replacement) {
        // A replacement document must not contain atomic operators. Put `_id`
        // directly into the document instead of `$setOnInsert`.
        return { document_id, update: { ...update, _id: document_id } };
    }

    const copy: Record<string, any> = { ...update };
    if (has_only_plain_fields(copy)) {
        // A plain update is treated by Mongoose as `$set`. Injecting `_id` into
        // `$set` would hit the immutable `_id` field if a concurrent write created
        // a matching document between the pre-hook check and the operation.
        // Convert the plain update into the operator form and use `$setOnInsert`.
        const plain_fields = { ...copy };
        for (const key of Object.keys(copy)) {
            delete copy[key];
        }
        copy.$set = plain_fields;
        copy.$setOnInsert = { ...(copy.$setOnInsert || {}), _id: document_id };
    } else {
        copy.$setOnInsert = { ...(copy.$setOnInsert || {}), _id: document_id };
    }
    return { document_id, update: copy };
}

// Mongoose 8 pre-middleware is callback-based (next), while Mongoose 9 is promise-based.
// Guard the callback to stay compatible with both runtime versions.
function continue_hook(next: any): void {
    if (typeof next === 'function') {
        next();
    }
}

const DEFAULT_MAX_SNAPSHOT_DOCUMENTS = 5000;

function get_collection_name(model: any): string {
    return model?.collection?.name ?? model?.collection?.collectionName ?? '';
}

function to_plain_object(doc: any): Record<string, any> {
    if (doc === null || doc === undefined) {
        return {};
    }
    return typeof doc.toObject === 'function' ? doc.toObject() : doc;
}

const UPDATE_KINDS = ['updateOne', 'updateMany', 'replaceOne'];
const DELETE_KINDS = ['deleteOne', 'deleteMany'];

/**
 * Mongoose plugin that records create/update/delete history into a dedicated
 * collection via pre/post hooks.
 *
 * Supported operations: `save`, `findOneAndUpdate`, `findOneAndReplace`,
 * `updateOne`, `updateMany`, `deleteOne`, `deleteMany`, `findOneAndDelete`,
 * `insertMany`, and a wrapper around `Model.bulkWrite`.
 *
 * Transactions:
 * - When the operation runs with a `session` (query/document options,
 *   `bulkWrite` options, or Mongoose `transactionAsyncLocalStorage` under
 *   `connection.transaction()`), the plugin joins that session: snapshots,
 *   re-reads and the history insert run inside the same transaction. For
 *   `Model.insertMany` the session is read from the inserted documents; with
 *   `insertMany({ lean: true })` and an explicitly passed `session` the plain
 *   objects carry no `$session()`, so history is then written outside the
 *   transaction — use `connection.transaction()` with
 *   `transactionAsyncLocalStorage` to keep it inside.
 * - A history write failure inside an active transaction (`session.inTransaction()`)
 *   is rethrown so the caller's transaction aborts — the document change and
 *   its history commit together or not at all. Without a transaction (no
 *   session, or a session outside `startTransaction`) the failure is logged
 *   and swallowed: the change is already applied and cannot be rolled back.
 */
export function auditTrailPlugin(schema: Schema, options: AuditTrailPluginOptions) {
    // Cast as any to tolerate the middleware signature difference between Mongoose 8 and 9.
    const s = schema as any;
    const opts: AuditTrailPluginOptions = { diffOnly: true, ...options };

    function created_record(model: any, document_id: any, method: string, current: Record<string, any>): AuditRecord {
        const changes = deep_diff({}, current, get_omit_paths('created', opts.omitPaths)) ?? {};
        return build_record(get_collection_name(model), model.modelName, document_id, 'created', method, changes, opts, {}, current);
    }

    function updated_record(
        model: any,
        document_id: any,
        method: string,
        old_document: Record<string, any>,
        current: Record<string, any>,
        allowed_paths?: Set<string> | null,
    ): AuditRecord | null {
        const raw_changes = deep_diff(old_document, current, get_omit_paths('updated', opts.omitPaths)) ?? {};
        // Drop changes the operation could not have produced (concurrent writes to
        // unrelated fields fall into the pre/post read window).
        const changes = filter_changes_by_paths(raw_changes, allowed_paths);
        if (!Object.keys(changes).length) {
            return null;
        }
        return build_record(
            get_collection_name(model),
            model.modelName,
            document_id,
            'updated',
            method,
            changes,
            opts,
            old_document,
            current,
        );
    }

    function deleted_record(model: any, document_id: any, method: string, old_document: Record<string, any>): AuditRecord {
        const changes = deep_diff(old_document, {}, get_omit_paths('deleted', opts.omitPaths)) ?? {};
        return build_record(get_collection_name(model), model.modelName, document_id, 'deleted', method, changes, opts, old_document, {});
    }

    async function write_upsert_created_history(query: any, method: string, session?: ClientSession): Promise<void> {
        const document_id = query._historyCtx?.upsert_document_id;
        if (!document_id) {
            return;
        }

        const model = query.model;
        const current = await with_session(model.findById(document_id), session).lean();
        if (!current) {
            // A concurrent write created a matching document between the pre-hook
            // check and the operation, so the upsert updated it instead of inserting.
            log_history_warning(
                opts.logger,
                `AuditTrailPlugin: upsert did not insert document ${document_id}; history skipped (possible concurrent write)`,
            );
            return;
        }

        await write_history_records(model, opts, [created_record(model, document_id, method, current)], session);
    }

    // =====================================================================
    // 1. Document save (created / updated)
    // =====================================================================
    s.pre('save', async function (this: any, next: any) {
        if (!isAuditEnabled()) {
            return continue_hook(next);
        }
        const session = this.$session?.() ?? get_transaction_session(this.constructor);

        try {
            if (this.isNew) {
                this._historyCtx = { save_is_new: true };
            } else {
                const old_document = await with_session(this.constructor.findOne({ _id: this._id }), session).lean();
                if (old_document) {
                    this._historyCtx = {
                        save_is_new: false,
                        old: old_document,
                        modified_paths: typeof this.modifiedPaths === 'function' ? this.modifiedPaths() : null,
                    };
                }
            }
        } catch (err) {
            handle_history_error(opts.logger, err, session, 'failed to snapshot the document(s) before the operation');
        }
        continue_hook(next);
    });

    s.post('save', async function (this: any) {
        const ctx = this._historyCtx;
        if (!ctx || !isAuditEnabled()) {
            return;
        }

        const model = this.constructor;
        const current = to_plain_object(this);
        const session = this.$session?.() ?? get_transaction_session(this.constructor);

        try {
            if (ctx.save_is_new) {
                await write_history_records(model, opts, [created_record(model, this._id, 'save', current)], session);
            } else if (ctx.old) {
                const allowed_paths = ctx.modified_paths?.length ? new Set<string>(ctx.modified_paths) : null;
                const record = updated_record(model, this._id, 'save', ctx.old, current, allowed_paths);
                if (record) {
                    await write_history_records(model, opts, [record], session);
                }
            }
        } catch (err) {
            handle_history_error(opts.logger, err, session);
        }
    });

    // =====================================================================
    // 2. Query update (findOneAndUpdate / findByIdAndUpdate / findOneAndReplace)
    // =====================================================================
    s.pre(['findOneAndUpdate', 'findOneAndReplace'], async function (this: any, next: any) {
        if (!isAuditEnabled()) {
            return continue_hook(next);
        }

        const model = this.model;
        const update = this.getUpdate() as Record<string, any>;
        const query_options = this.getOptions() ?? {};
        const session = query_options.session ?? get_transaction_session(model);

        try {
            const existing = await with_session(model.findOne(this.getQuery()), session).lean();

            if (!existing) {
                if (query_options.upsert) {
                    const is_replacement = this.op === 'findOneAndReplace';
                    const { document_id, update: update_with_id } = ensure_upsert_document_id(update, this.getQuery(), is_replacement);
                    this.setUpdate(update_with_id);
                    if (document_id) {
                        this._historyCtx = { upsert_document_id: document_id };
                    }
                }
                return continue_hook(next);
            }

            this._historyCtx = { old: existing };
        } catch (err) {
            handle_history_error(opts.logger, err, session, 'failed to snapshot the document(s) before the operation');
        }
        continue_hook(next);
    });

    s.post(['findOneAndUpdate', 'findOneAndReplace'], async function (this: any, result: any) {
        const ctx = this._historyCtx;
        if (!ctx || !isAuditEnabled()) {
            return;
        }

        const model = this.model;
        const method = this.op;
        const session = this.getOptions?.()?.session ?? get_transaction_session(this.model);

        try {
            if (ctx.upsert_document_id) {
                await write_upsert_created_history(this, method, session);
                return;
            }

            // result === null means the filter matched nothing at execution time.
            if (!ctx.old || result === null || result === undefined) {
                return;
            }

            const current = await with_session(model.findById(ctx.old._id), session).lean();
            if (!current) {
                return;
            }

            // replaceOne/findOneAndReplace rewrites the whole document: no path filter.
            const allowed_paths = method === 'findOneAndReplace' ? null : collect_update_paths(this.getUpdate());
            const record = updated_record(model, ctx.old._id, method, ctx.old, current, allowed_paths);
            if (record) {
                await write_history_records(model, opts, [record], session);
            }
        } catch (err) {
            handle_history_error(opts.logger, err, session);
        }
    });

    // =====================================================================
    // 3. Query update (updateOne / updateMany)
    // =====================================================================
    s.pre(['updateOne', 'updateMany'], { document: false, query: true }, async function (this: any, next: any) {
        if (!isAuditEnabled()) {
            return continue_hook(next);
        }

        const model = this.model;
        const update = this.getUpdate() as Record<string, any>;
        const query_options = this.getOptions() ?? {};
        const session = query_options.session ?? get_transaction_session(model);

        try {
            const is_many = this.op === 'updateMany';
            const max_snapshot = opts.maxSnapshotDocuments ?? DEFAULT_MAX_SNAPSHOT_DOCUMENTS;
            const query = with_session(model.find(this.getQuery()), session);
            // updateOne affects a single document: snapshot only that one.
            query.limit(is_many ? max_snapshot + 1 : 1);
            const existing_docs = await query.lean();

            if (is_many && existing_docs.length > max_snapshot) {
                log_history_warning(
                    opts.logger,
                    `AuditTrailPlugin: ${this.op} matched more than ${max_snapshot} documents; history for this operation is skipped`,
                );
                return continue_hook(next);
            }

            if (!existing_docs.length) {
                if (query_options.upsert && query_options.upsert !== false) {
                    const { document_id, update: update_with_id } = ensure_upsert_document_id(update, this.getQuery());
                    this.setUpdate(update_with_id);
                    if (document_id) {
                        this._historyCtx = { upsert_document_id: document_id };
                    }
                }
                return continue_hook(next);
            }

            this._historyCtx = { olds: existing_docs };
        } catch (err) {
            handle_history_error(opts.logger, err, session, 'failed to snapshot the document(s) before the operation');
        }
        continue_hook(next);
    });

    s.post(['updateOne', 'updateMany'], { document: false, query: true }, async function (this: any, result: any) {
        const ctx = this._historyCtx;
        if (!ctx || !isAuditEnabled()) {
            return;
        }

        const model = this.model;
        const method = this.op;
        const session = this.getOptions?.()?.session ?? get_transaction_session(this.model);

        try {
            if (ctx.upsert_document_id) {
                await write_upsert_created_history(this, method, session);
                return;
            }

            if (!ctx.olds?.length || !result?.matchedCount) {
                return;
            }

            const ids = ctx.olds.map((old: any) => old._id);
            const currents = await with_session(model.find({ _id: { $in: ids } }), session).lean();
            const by_id = new Map(currents.map((doc: any) => [String(doc._id), doc]));
            const allowed_paths = collect_update_paths(this.getUpdate());

            const records = ctx.olds
                .map((old: any) => {
                    const current = by_id.get(String(old._id));
                    if (!current) {
                        return null;
                    }
                    return updated_record(model, old._id, method, old, current, allowed_paths);
                })
                .filter(Boolean);

            await write_history_records(model, opts, records, session);
        } catch (err) {
            handle_history_error(opts.logger, err, session);
        }
    });

    // =====================================================================
    // 4. Query delete (findOneAndDelete / findByIdAndDelete)
    // =====================================================================
    s.post('findOneAndDelete', async function (this: any, deleted: any) {
        if (!isAuditEnabled() || !deleted) {
            return;
        }

        const model = this.model;
        const session = this.getOptions?.()?.session ?? get_transaction_session(this.model);
        try {
            const old_document = to_plain_object(deleted);
            await write_history_records(model, opts, [deleted_record(model, old_document._id, this.op, old_document)], session);
        } catch (err) {
            handle_history_error(opts.logger, err, session);
        }
    });

    // =====================================================================
    // 5. Query delete (deleteOne / deleteMany)
    // =====================================================================
    // Note: doc.deleteOne() also triggers query middleware with filter {_id},
    // so query hooks cover both Model.deleteOne() and doc.deleteOne().
    s.pre(['deleteOne', 'deleteMany'], { document: false, query: true }, async function (this: any, next: any) {
        if (!isAuditEnabled()) {
            return continue_hook(next);
        }
        const session = this.getOptions?.()?.session ?? get_transaction_session(this.model);

        try {
            const is_many = this.op === 'deleteMany';
            const max_snapshot = opts.maxSnapshotDocuments ?? DEFAULT_MAX_SNAPSHOT_DOCUMENTS;
            const query = with_session(this.model.find(this.getQuery()), session);
            // deleteOne affects a single document: snapshot only that one.
            query.limit(is_many ? max_snapshot + 1 : 1);
            const existing_docs = await query.lean();

            if (is_many && existing_docs.length > max_snapshot) {
                log_history_warning(
                    opts.logger,
                    `AuditTrailPlugin: ${this.op} matched more than ${max_snapshot} documents; history for this operation is skipped`,
                );
                return continue_hook(next);
            }

            if (existing_docs.length) {
                this._historyCtx = { olds: existing_docs };
            }
        } catch (err) {
            handle_history_error(opts.logger, err, session, 'failed to snapshot the document(s) before the operation');
        }
        continue_hook(next);
    });

    s.post(['deleteOne', 'deleteMany'], { document: false, query: true }, async function (this: any, result: any) {
        const ctx = this._historyCtx;
        if (!ctx?.olds?.length || !isAuditEnabled() || !result?.deletedCount) {
            return;
        }

        const model = this.model;
        const method = this.op;
        const session = this.getOptions?.()?.session ?? get_transaction_session(this.model);

        try {
            const records = ctx.olds.map((old: any) => deleted_record(model, old._id, method, old));
            await write_history_records(model, opts, records, session);
        } catch (err) {
            handle_history_error(opts.logger, err, session);
        }
    });

    // =====================================================================
    // 6. insertMany
    // =====================================================================
    s.post('insertMany', async function (this: any, docs: any) {
        if (!isAuditEnabled() || !Array.isArray(docs) || !docs.length) {
            return;
        }

        const session = docs[0]?.$session?.() ?? get_transaction_session(this);
        try {
            const records = docs.map((doc: any) => {
                const current = to_plain_object(doc);
                return created_record(this, current._id, 'insertMany', current);
            });
            await write_history_records(this, opts, records, session);
        } catch (err) {
            handle_history_error(opts.logger, err, session);
        }
    });

    // =====================================================================
    // 7. bulkWrite (Mongoose has no native bulkWrite middleware)
    // =====================================================================
    s.statics.bulkWrite = async function (this: any, operations: any[], bulk_options?: any) {
        const original: any = Object.getPrototypeOf(this)?.bulkWrite ?? this?.base?.Model?.bulkWrite;
        if (typeof original !== 'function') {
            throw new AuditError('AuditTrailPlugin: original Model.bulkWrite is not available');
        }
        if (!isAuditEnabled()) {
            return original.call(this, operations, bulk_options);
        }

        const session = bulk_options?.session ?? get_transaction_session(this);
        const max_snapshot = opts.maxSnapshotDocuments ?? DEFAULT_MAX_SNAPSHOT_DOCUMENTS;
        // Index-aligned snapshots: snapshots[i] corresponds to operations[i].
        const snapshots: any[] = new Array(operations?.length ?? 0).fill(null);
        // `_id`s that earlier delete operations in this batch will remove. Later
        // operations no longer match them, so snapshot filters must exclude them.
        const claimed_ids: Types.ObjectId[] = [];

        try {
            for (let i = 0; i < (operations ?? []).length; i++) {
                const op = operations[i];
                const kind = Object.keys(op)[0];
                const spec = op?.[kind];
                if (!spec || ![...UPDATE_KINDS, ...DELETE_KINDS].includes(kind)) {
                    continue;
                }

                // Single-document operations (updateOne/replaceOne/deleteOne)
                // affect only one document: snapshot only that one.
                const is_single = ['updateOne', 'replaceOne', 'deleteOne'].includes(kind);
                const is_many = kind === 'updateMany' || kind === 'deleteMany';
                const is_delete = DELETE_KINDS.includes(kind);

                const base = spec.filter ?? {};
                const filter = claimed_ids.length ? { ...base, _id: { $nin: claimed_ids } } : base;
                const query = with_session(this.find(filter), session);
                if (is_single) {
                    query.limit(1);
                } else if (is_many) {
                    query.limit(max_snapshot + 1);
                }
                const olds = await query.lean();

                if (is_many && olds.length > max_snapshot) {
                    log_history_warning(
                        opts.logger,
                        `AuditTrailPlugin: bulkWrite ${kind} matched more than ${max_snapshot} documents; history for this operation is skipped`,
                    );
                    continue;
                }

                if (is_delete) {
                    for (const old of olds) {
                        claimed_ids.push(old._id);
                    }
                }

                snapshots[i] = { kind, olds };
            }
        } catch (err) {
            handle_history_error(opts.logger, err, session, 'failed to snapshot the document(s) before the operation');
        }

        const result = await original.call(this, operations, bulk_options);

        try {
            const records: AuditRecord[] = [];

            const update_ids = snapshots
                .filter(snapshot => snapshot && UPDATE_KINDS.includes(snapshot.kind))
                .flatMap(snapshot => snapshot.olds.map((old: any) => old._id));
            const currents = update_ids.length ? await with_session(this.find({ _id: { $in: update_ids } }), session).lean() : [];
            const by_id = new Map(currents.map((doc: any) => [String(doc._id), doc]));

            for (let i = 0; i < (operations ?? []).length; i++) {
                const op = operations[i];
                const kind = Object.keys(op)[0];
                const spec = op?.[kind];
                if (!spec) {
                    continue;
                }

                if (kind === 'insertOne') {
                    const document_id = spec.document?._id ?? result?.insertedIds?.[i];
                    if (!document_id) {
                        continue;
                    }
                    const current = await with_session(this.findById(document_id), session).lean();
                    if (current) {
                        records.push(created_record(this, document_id, 'bulkWrite', current));
                    }
                } else if (UPDATE_KINDS.includes(kind)) {
                    const snapshot = snapshots[i];
                    if (!snapshot) {
                        continue;
                    }
                    // replaceOne rewrites the whole document: no path filter.
                    const allowed_paths = kind === 'replaceOne' ? null : collect_update_paths(spec.update);
                    for (const old of snapshot.olds) {
                        const current = by_id.get(String(old._id));
                        if (!current) {
                            continue;
                        }
                        const record = updated_record(this, old._id, 'bulkWrite', old, current, allowed_paths);
                        if (record) {
                            records.push(record);
                        }
                    }
                } else if (DELETE_KINDS.includes(kind)) {
                    const snapshot = snapshots[i];
                    if (!snapshot) {
                        continue;
                    }
                    for (const old of snapshot.olds) {
                        records.push(deleted_record(this, old._id, 'bulkWrite', old));
                    }
                }
            }

            await write_history_records(this, opts, records, session);
        } catch (err) {
            handle_history_error(opts.logger, err, session);
        }

        return result;
    };
}

// Re-exported for tests and advanced consumers that build records manually.
export { build_record, write_history_records };
export { getAuditModifiedBy, getAuditSource };
