# Mongoose History Audit

[![Build Status](https://github.com/dm-kamaev/mongoose-history-audit/actions/workflows/test.yml/badge.svg)](https://github.com/dm-kamaev/mongoose-history-audit/actions/workflows/test.yml)
[![Coverage](./badges/coverage.svg)](https://github.com/dm-kamaev/mongoose-history-audit/actions/workflows/test.yml)
[![npm version](https://img.shields.io/npm/v/mongoose-history-audit.svg)](https://www.npmjs.com/package/mongoose-history-audit)

Mongoose plugin that intercepts document changes and writes an **audit trail** (diff history) to a dedicated collection. Tracks **who** changed the data via AsyncLocalStorage context, with first-class support for **NestJS** (decorators) and **Fastify** (hooks).

- Records `created` / `updated` / `deleted` actions with field-level diffs
- `modified_by` — the id of the person who changed the data
- `source` — the channel that produced the change (`http`, `cron`, `cli`, `rabbitmq`, or your own, registered via `registerAuditSources()`)
- Transaction-safe: history commits (or aborts) together with the data
- Zero runtime dependencies

## Install

```sh
npm i mongoose-history-audit mongoose -S
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

## How it works

```text
   ┌─ context sources (who / channel) ───────────────────────────────┐
   │ runWithAuditContext · @AuditTrail · Fastify hook · resolver     │
   └────────────────────────────┬────────────────────────────────────┘
                                ▼
   AsyncLocalStorage { enabled, modifiedBy, source }
                                │
   mongoose write ─────────────┤
   (save / update / delete / bulkWrite)
                                ▼
                audit enabled? ── no ──▶ write only, no history
                                │ yes
                                ▼
                1. snapshot old state (pre-hook, same session)
                2. apply the data change
                3. diff old vs new
                4. build snake_case record
                                │
                                ▼
                insert into the history collection
                (same transaction as the data change, if any)
                                │
                                ▼
   ┌────────────────────────────────────────────────────────────┐
   │ users_audit_history                                        │
   │ { action, changes, modified_by, source, created_at, … } │
   └────────────────────────────────────────────────────────────┘
```

## Setting `modified_by` (who changed the data)

The audit only runs inside an **active context**. Four ways to activate it, all funneling into one AsyncLocalStorage:

### 1. Explicit scope — works everywhere

```ts
import { runWithAuditContext } from 'mongoose-history-audit';

await runWithAuditContext({ enabled: true, modifiedBy: user.id, source: 'http' }, () => repo.save(doc));
```

### 2. NestJS — automatic from the request

```ts
import { AuditTrail, AuditTrailInterceptor } from 'mongoose-history-audit/nest';

// global interceptor (main.ts / core module)
app.useGlobalInterceptors(app.get(AuditTrailInterceptor));

@Controller('users')
class UserController {
    @Post()
    @AuditTrail() // modifiedBy read from request.user._id ?? request.user.id ?? null
    create() { ... }

    @Patch(':id')
    @AuditTrail({ getModifiedBy: req => req.accountId }) // custom extraction
    update() { ... }
}
```

Without `@AuditTrail()` the interceptor runs the handler with an explicitly **disabled** context — no leaking between requests.

### 3. Fastify — onRequest hook

```ts
import { createAuditContextHook } from 'mongoose-history-audit/fastify';

fastify.addHook('onRequest', createAuditContextHook()); // default: request.user?._id
fastify.addHook('onRequest', createAuditContextHook({ getModifiedBy: req => req.accountId, source: 'http' }));
```

If you already use `@fastify/request-context`, skip the hook and register a `setAuditContextResolver()` reading from it instead.

### 4. App-wide resolver (CLS-based apps)

```ts
import { setAuditContextResolver } from 'mongoose-history-audit';

setAuditContextResolver(() => ({
    enabled: true,
    modifiedBy: currentUserId,
    source: 'http',
}));
```

Scoped contexts (1–3) always win over the resolver.

### CLI / cron

```ts
import { AuditContext } from 'mongoose-history-audit/nest';

@AuditContext({ source: () => process.env.HISTORY_SOURCE ?? 'cron' })
@Command({ command: 'rewards:archive' })
async archive() { ... } // modified_by: null (system record)
```

## Public API

### `mongoose-history-audit` (core)

| Export                                             | Description                                                          |
| -------------------------------------------------- | -------------------------------------------------------------------- |
| `auditTrailPlugin`                                 | The Mongoose plugin — `schema.plugin(auditTrailPlugin, options)`     |
| `runWithAuditContext(ctx, fn)`                     | Runs `fn` inside an audit scope; the primary way to set `modifiedBy` |
| `setAuditContextResolver(fn)`                      | Registers an app-wide context fallback (e.g. CLS-backed)             |
| `resetAuditContextResolver()`                      | Removes the resolver (tests)                                         |
| `getAuditContext()`                                | Current context (scoped → resolver → `undefined`)                    |
| `isAuditEnabled()`                                 | Whether auditing is active right now                                 |
| `getAuditModifiedBy()`                             | Resolved `modifiedBy` as `ObjectId \| null`                          |
| `getAuditSource()`                                 | Current source of the change (`http`, `cron`, …)                     |
| `registerAuditSources(...names)`                   | Registers custom channels; any other use **throws**                  |
| `isKnownSource(name)`                              | Whether a channel is built-in or registered                          |
| `assertAuditSource(name)` / `resolveSource(value)` | Validation helpers used by the integrations                          |
| `AuditError`                                       | Error thrown for library misuse (catch via `instanceof AuditError`)  |
| `SYSTEM_AUDIT_MODIFIED_BY`                         | `null` sentinel for system records                                   |

Types: `AuditContext`, `AuditSource`, `AuditRecord`, `AuditAction`, `AuditChange`, `AuditTrailPluginOptions`, `AuditLogger`, `AuditMetadataContext`.

### `mongoose-history-audit/nest`

| Export                                  | Description                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------- |
| `@AuditTrail(options?)`                 | Method/class decorator — audits the handler, `modifiedBy` read from the request |
| `@AuditContext(options?)`               | Method decorator — manual context for CLI/cron (default `source: 'cli'`)        |
| `createAuditContextDecorator(defaults)` | Factory for named preset decorators                                             |
| `CronAuditContext(options?)`            | Preset: `@AuditContext` without `modifiedBy`                                    |
| `AuditTrailInterceptor`                 | Global interceptor — **required** for `@AuditTrail` to take effect              |
| `AUDIT_TRAIL_KEY`                       | Metadata key read by the interceptor (Reflector)                                |

Types: `AuditContextOptions`, `AuditTrailOptions`.

### `mongoose-history-audit/fastify`

| Export                             | Description                                                             |
| ---------------------------------- | ----------------------------------------------------------------------- |
| `createAuditContextHook(options?)` | `onRequest` hook that activates the audit context for the whole request |

> Snake_case exports (`build_record`, `deep_diff`, `write_history_records`, …) are internal helpers — not part of the stable API.

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
    "source": "http",
    "created_at": ISODate("...")
}
```

| Field              | Type                                  | Description                                                |
| ------------------ | ------------------------------------- | ---------------------------------------------------------- |
| `collection_name`  | `string`                              | Source collection where the change happened                |
| `model_name`       | `string`                              | Mongoose model name                                        |
| `document_id`      | `ObjectId`                            | Id of the affected document                                |
| `action`           | `'created' \| 'updated' \| 'deleted'` | Type of change                                             |
| `method`           | `string`                              | Mongoose method that produced it (`save`, `updateMany`, …) |
| `changes`          | `object`                              | Field-level diff: `{ field: { old, new } }`                |
| `old_document`     | `object?`                             | Pre-image snapshot — only when `diffOnly: false`           |
| `current_document` | `object?`                             | Post-image snapshot — only when `diffOnly: false`          |
| `modified_by`      | `ObjectId \| null`                    | Who changed it; `null` = system record (cron/CLI)          |
| `source`           | `string`                              | Channel that produced the change (`http`, `cron`, …)       |
| `metadata`         | `object?`                             | Extra fields from the `metadata` option                    |
| `created_at`       | `Date`                                | When the history record was written                        |

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

## Extending sources

The source is a plain open string. Built-ins (`http`, `cron`, `cli`, `rabbitmq`) are pre-registered; a custom channel must be registered at startup or any use **throws**:

```ts
import { registerAuditSources } from 'mongoose-history-audit';

registerAuditSources('kafka', 'grpc'); // once, at application startup

await runWithAuditContext(
    { enabled: true, modifiedBy, source: 'kafka' }, // ok — registered
    fn,
);

await runWithAuditContext(
    { enabled: true, modifiedBy, source: 'kafka2' }, // throws: Unknown audit source "kafka2"...
    fn,
);
```

### Named preset decorators (NestJS)

```ts
import { createAuditContextDecorator } from 'mongoose-history-audit/nest';

const KafkaAuditContext = createAuditContextDecorator({ source: 'kafka' });

@KafkaAuditContext({ modifiedBy }) // per-call options override baked-in defaults
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
npm test              # 150 tests (unit + mongodb-memory-server integration)
npm run test:cov      # coverage, 90% statements threshold enforced
npm run lint
npm run typecheck     # tsc 7.0
npm run build         # dist/
make badge            # regenerate coverage badge SVG
```

## License

MIT
