import { Types } from 'mongoose';

export type AuditAction = 'created' | 'updated' | 'deleted';

/**
 * Audit source — a plain open string. The validation registry
 * (built-ins `http`/`cron`/`cli`/`rabbitmq` + `registerAuditSources()`)
 * lives in `user_context.ts`; an unregistered value throws at context entry
 * or record build.
 */
export type AuditSource = string;

export interface AuditChange {
    old: any;
    new: any;
}

export interface AuditLogger {
    error(message: string, error?: any): void;
    warn?(message: string, error?: any): void;
}

export interface AuditRecord {
    collection_name: string;
    model_name: string;
    document_id: Types.ObjectId;
    action: AuditAction;
    method: string;
    changes: Record<string, AuditChange>;
    old_document?: Record<string, any>;
    current_document?: Record<string, any>;
    modified_by: Types.ObjectId | null;
    source: AuditSource;
    metadata?: Record<string, any>;
    created_at: Date;
}

export interface AuditMetadataContext {
    old_document?: Record<string, any>;
    current_document?: Record<string, any>;
}

export interface AuditTrailPluginOptions {
    historyCollectionName: string;
    diffOnly?: boolean;
    omitPaths?: string[];
    metadata?: Record<string, (context: AuditMetadataContext) => any>;
    logger?: AuditLogger;
    /**
     * Maximum number of documents snapshotted for `updateMany`/`deleteMany`.
     * If the filter matches more documents, history for that operation is skipped
     * (a warning is emitted through `logger.warn`) to avoid unbounded memory usage.
     * Defaults to 5000.
     */
    maxSnapshotDocuments?: number;
}
