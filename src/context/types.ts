import { Types } from 'mongoose';

export type AuditAction = 'created' | 'updated' | 'deleted';

/**
 * Known initiator channels. The type is an open union: any string is accepted
 * so consumers can add their own channels (`'kafka'`, `'grpc'`, ...) without
 * waiting for a library release. Unknown values pass through to the record
 * unchanged; `registerAuditInitiators()` only affects validation warnings.
 */
export const AuditInitiator = {
    http: 'http',
    cron: 'cron',
    cli: 'cli',
    rabbitmq: 'rabbitmq',
} as const;

export type AuditInitiator = (typeof AuditInitiator)[keyof typeof AuditInitiator] | (string & {});

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
    initiator: AuditInitiator;
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
