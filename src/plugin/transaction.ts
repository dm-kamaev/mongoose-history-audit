import { ClientSession } from 'mongoose';

// Relies on mongoose's private transactionAsyncLocalStorage field; behavior verified on mongoose ^9.
export function get_transaction_session(model: any): ClientSession | undefined {
    return model?.db?.base?.transactionAsyncLocalStorage?.getStore()?.session;
}

export function with_session(query: any, session?: ClientSession): any {
    return session ? query.session(session) : query;
}
