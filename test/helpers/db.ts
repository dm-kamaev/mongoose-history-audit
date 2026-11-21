import mongoose, { Schema, Model, Connection } from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

export const HISTORY_COLLECTION = 'test_audit_history';

let replset: MongoMemoryReplSet;

export async function start_db(): Promise<void> {
    replset = await MongoMemoryReplSet.create({
        replSet: { count: 1, name: 'audit-test' },
    });
    // Opt in: queries inside connection.transaction() pick up the session
    // automatically, so data writes and plugin history share one transaction.
    mongoose.set('transactionAsyncLocalStorage', true);
    await mongoose.connect(replset.getUri(), { dbName: 'audit_test' });
}

export async function stop_db(): Promise<void> {
    await mongoose.disconnect();
    if (replset) {
        await replset.stop();
    }
}

export async function clean_history(): Promise<void> {
    await mongoose.connection.db!.collection(HISTORY_COLLECTION).deleteMany({});
}

export async function read_history(filter: Record<string, any> = {}): Promise<any[]> {
    return mongoose.connection.db!.collection(HISTORY_COLLECTION).find(filter).toArray();
}

export interface TestDoc {
    name: string;
    priority?: number;
    blocks?: mongoose.Types.ObjectId[];
    assignments?: { _id: mongoose.Types.ObjectId; priority: number }[];
    is_archived?: boolean;
    created_at?: Date;
    updated_at?: Date;
}

export function make_schema(options: Record<string, any> = {}): Schema {
    const schema = new Schema<TestDoc>(
        {
            name: { type: String },
            priority: { type: Number },
            blocks: [{ type: Schema.Types.ObjectId }],
            assignments: [{ _id: Schema.Types.ObjectId, priority: Number }],
            is_archived: { type: Boolean, default: false },
        },
        {
            timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
            ...options,
        },
    );
    return schema;
}

export function model_for(schema: Schema, name = 'AuditTest'): Model<TestDoc> {
    // Avoid OverwriteModelError when a suite registers the same name twice.
    if (mongoose.models[name]) {
        mongoose.deleteModel(name);
    }
    return mongoose.model<TestDoc>(name, schema);
}

export function connection(): Connection {
    return mongoose.connection;
}
