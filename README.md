# mongoose-history-audit

[![Build Status](https://github.com/dm-kamaev/mongoose-history-audit/actions/workflows/test.yml/badge.svg)](https://github.com/dm-kamaev/mongoose-history-audit/actions/workflows/test.yml)
[![Coverage](./badges/coverage.svg)](https://github.com/dm-kamaev/mongoose-history-audit/actions/workflows/test.yml)
[![npm version](https://img.shields.io/npm/v/mongoose-history-audit.svg)](https://www.npmjs.com/package/mongoose-history-audit)

Mongoose plugin that intercepts document changes and writes an **audit trail** (diff history) to a dedicated collection. Tracks **who** changed the data via AsyncLocalStorage context, with first-class support for **NestJS** (decorators) and **Fastify** (hooks).

- Records `created` / `updated` / `deleted` actions with field-level diffs
- `modified_by` — the id of the person who changed the data
- `initiator` — the channel that produced the change (`http`, `cron`, `cli`, `rabbitmq`, or your own)
- Transaction-safe: history commits (or aborts) together with the data
- Zero runtime dependencies

## Install

```bash
npm i mongoose-history-audit mongoose
```

## Quick start

```ts
import { Schema } from 'mongoose';
import { auditTrailPlugin } from 'mongoose-history-audit';

const userSchema = new Schema({ name: String, email: String });
userSchema.plugin(auditTrailPlugin, {
    historyCollectionName: 'users_audit_history',
});
```

Every write through Mongoose (`save`, `findOneAndUpdate`, `updateOne/Many`, `deleteOne/Many`, `insertMany`, `bulkWrite`, …) now produces a record in `users_audit_history`.

## Setting `user_id` (who changed the data)

The audit only runs inside an **active context**. Four ways to activate it, all funneling into one AsyncLocalStorage:

### 1. Explicit scope — works everywhere

```ts
import { runWithAuditContext, withHistoryUser } from 'mongoose-history-audit';

await runWithAuditContext({ enabled: true, userId: user.id, initiator: 'http' }, () => repo.save(doc));

// convenience wrapper: pins userId, keeps ambient initiator
await withHistoryUser(user.id, () => repo.save(doc));
```

### 2. NestJS — automatic from the request

```ts
import { AuditTrail, AuditTrailInterceptor } from 'mongoose-history-audit/nest';

// global interceptor (main.ts / core module)
app.useGlobalInterceptors(app.get(AuditTrailInterceptor));

@Controller('users')
class UserController {
    @Post()
    @AuditTrail() // userId read from request.user._id ?? request.user.id ?? null
    create() { ... }

    @Patch(':id')
    @AuditTrail({ getUserId: req => req.accountId }) // custom extraction
    update() { ... }
}
```

Without `@AuditTrail()` the interceptor runs the handler with an explicitly **disabled** context — no leaking between requests.

### 3. Fastify — onRequest hook

```ts
import { createAuditContextHook } from 'mongoose-history-audit/fastify';

fastify.addHook('onRequest', createAuditContextHook()); // default: request.user?._id
fastify.addHook('onRequest', createAuditContextHook({ getUserId: req => req.accountId, initiator: 'http' }));
```

If you already use `@fastify/request-context`, skip the hook and register a `setAuditContextResolver()` reading from it instead.

### 4. App-wide resolver (CLS-based apps)

```ts
import { setAuditContextResolver } from 'mongoose-history-audit';

setAuditContextResolver(() => ({
    enabled: true,
    userId: currentUserId,
    initiator: 'http',
}));
```

Scoped contexts (1–3) always win over the resolver.

### CLI / cron

```ts
import { AuditContext } from 'mongoose-history-audit/nest';

@AuditContext({ initiator: () => process.env.HISTORY_INITIATOR ?? 'cron' })
@Command({ command: 'rewards:archive' })
async archive() { ... } // modified_by: null (system record)
```

## Record format

History collection fields are **snake_case**:

```json
{
    "collection_name": "users",
    "model_name": "User",
    "document_id": ObjectId("..."),
    "action": "updated",
    "method": "findOneAndUpdate",
    "changes": {
        "email": { "old": "a@x.com", "new": "b@x.com" }
    },
    "modified_by": ObjectId("..."),
    "initiator": "http",
    "created_at": ISODate("...")
}
```

- Values keep their **original BSON types** (`Date`, `ObjectId`) — no stringification
- Subdocument arrays with `_id` shrink to only the elements that changed (added → `old: []`, removed → `new: []`, modified → one version per side)
- `diffOnly: false` (option) additionally stores `old_document` / `current_document` snapshots

### Omit rules

By default `__v`, root `_id`, and `created_at`/`updated_at`/`createdAt`/`updatedAt` are excluded from `changes`. Extend via `omitPaths`:

| Rule       | Meaning                   | Example         |
| ---------- | ------------------------- | --------------- |
| plain name | prune key at any depth    | `secret`        |
| dot path   | prune subtree exactly     | `sub.secret`    |
| wildcard   | one path segment          | `list.*.secret` |
| `^` anchor | key only at document root | `^_id`          |

## Extending initiators

The `AuditInitiator` type is an open union — any string is accepted:

```ts
import { registerAuditInitiators, AuditInitiator } from 'mongoose-history-audit';

registerAuditInitiators('kafka', 'grpc'); // at startup — silences the warning

await runWithAuditContext(
    { enabled: true, userId, initiator: 'kafka' }, // passes through unchanged
    fn,
);
```

Unregistered values are **written to the record unchanged** (a warning is logged through `logger.warn`) — the audit trail must record the real channel.

### Named preset decorators (NestJS)

```ts
import { createAuditContextDecorator } from 'mongoose-history-audit/nest';

const KafkaAuditContext = createAuditContextDecorator({ initiator: 'kafka' });

@KafkaAuditContext({ userId }) // per-call options override baked-in defaults
async handle(msg) { ... }
```

## Transactions

When the operation runs with a session (query/document options, `bulkWrite` options, or `connection.transaction()` with `transactionAsyncLocalStorage`), the plugin joins it: snapshots, re-reads and the history insert run in the same transaction.

- History failure **inside an active transaction** → rethrown, caller's transaction aborts (data + history commit together or not at all)
- Without a transaction → logged and swallowed (the data change already applied)
- Enable automatic session pickup: `mongoose.set('transactionAsyncLocalStorage', true)`

## Options

```ts
schema.plugin(auditTrailPlugin, {
    historyCollectionName: 'my_history', // required
    diffOnly: true, // default: store only `changes`
    omitPaths: ['internal_field'], // extra omit rules
    maxSnapshotDocuments: 5000, // updateMany/deleteMany safety cap
    metadata: { ip: ({ current_document }) => current_document?.ip },
    logger: console, // { error, warn? } — defaults to stderr
});
```

## Supported operations

`save`, `findOneAndUpdate`, `findOneAndReplace`, `updateOne`, `updateMany`, `deleteOne`, `deleteMany`, `findOneAndDelete`, `insertMany`, and a wrapper around `Model.bulkWrite`.

**Not tracked:** direct driver writes (`collection.insertOne`), aggregations with `$out`/`$merge`.

## TypeScript 7

Built and tested with TypeScript 7.0 (`tsc`). The repo runs ts-jest / typescript-eslint against the TS 6 API side-by-side, per the [official TS 7 transition guide](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/).

## Development

```bash
npm install
npm test              # 151 tests (unit + mongodb-memory-server integration)
npm run test:cov      # coverage, 70% statements threshold enforced
npm run lint
npm run typecheck     # tsc 7.0
npm run build         # dist/
make badge            # regenerate coverage badge SVG
```

## License

MIT
