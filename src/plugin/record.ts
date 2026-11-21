import { ClientSession } from 'mongoose';
import { AuditLogger, AuditRecord, AuditTrailPluginOptions } from '../context/types';
import { assertAuditSource, getAuditSource, getAuditModifiedBy } from '../context/user_context';

const logged_errors = new WeakSet<object>();

function fallback_log(message: string, err?: any): void {
    const details = err === undefined ? '' : `: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`;
    process.stderr.write(`[AuditTrailPlugin] ${message}${details}\n`);
}

function log_history_error(logger: AuditLogger | undefined, message: string, err: any): void {
    if (err && typeof err === 'object') {
        if (logged_errors.has(err)) {
            return;
        }
        logged_errors.add(err);
    }
    if (logger) {
        logger.error(message, err);
    } else {
        fallback_log(message, err);
    }
}

export function handle_history_error(logger: AuditLogger | undefined, err: any, session?: ClientSession, detail?: string): void {
    const in_transaction = Boolean(session?.inTransaction?.());
    const consequence = in_transaction
        ? 'aborting the transaction: the data change and its history commit together or not at all'
        : 'the data change is applied but its history record is LOST';
    log_history_error(logger, `AuditTrailPlugin: ${detail ?? 'failed to write the history record'}; ${consequence}`, err);
    if (in_transaction) {
        throw err;
    }
}

export function log_history_warning(logger: AuditLogger | undefined, message: string): void {
    if (logger) {
        logger.warn?.(message);
    } else {
        fallback_log(message);
    }
}

export function get_omit_paths(action: 'created' | 'updated' | 'deleted', custom_omit_paths?: string[]): string[] {
    const always_omit = ['__v'];
    const timestamp_paths = ['created_at', 'updated_at', 'createdAt', 'updatedAt'];
    const custom = custom_omit_paths ?? [];

    if (action === 'deleted') {
        return [...always_omit, '^_id', ...custom];
    }

    return [...always_omit, '^_id', ...timestamp_paths, ...custom];
}

export function build_record(
    collection_name: string,
    model_name: string,
    document_id: any,
    action: 'created' | 'updated' | 'deleted',
    method: string,
    changes: Record<string, any>,
    options: AuditTrailPluginOptions,
    old_document?: Record<string, any>,
    current_document?: Record<string, any>,
): AuditRecord {
    const source = getAuditSource() ?? 'http';
    assertAuditSource(source);

    const record: AuditRecord = {
        collection_name,
        model_name,
        document_id,
        action,
        method,
        changes,
        modified_by: getAuditModifiedBy(),
        source,
        created_at: new Date(),
    };

    if (!options.diffOnly) {
        record.old_document = old_document;
        record.current_document = current_document;
    }

    if (options.metadata) {
        record.metadata = {};
        for (const key of Object.keys(options.metadata)) {
            record.metadata[key] = options.metadata[key]({ old_document, current_document });
        }
    }

    return record;
}

export async function write_history_records(
    model: any,
    options: AuditTrailPluginOptions,
    records: AuditRecord[],
    session?: ClientSession,
): Promise<void> {
    if (!records.length) {
        return;
    }
    const connection = model?.db ?? model?.connection;
    const collection = connection.collection(options.historyCollectionName);
    const write_options = session ? { session } : undefined;
    try {
        if (records.length === 1) {
            await collection.insertOne(records[0], write_options);
        } else {
            await collection.insertMany(records, write_options);
        }
    } catch (err) {
        const actions = [...new Set(records.map(record => record.action))].join(',');
        const documents = records
            .slice(0, 5)
            .map(record => String(record.document_id))
            .join(', ');
        handle_history_error(
            options.logger,
            err,
            session,
            `failed to write ${records.length} history record(s) for ${model?.modelName} into ` +
                `${options.historyCollectionName} (method: ${records[0]?.method}, actions: ${actions}, documents: ${documents})`,
        );
    }
}
