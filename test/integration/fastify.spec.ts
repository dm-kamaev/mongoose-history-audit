import Fastify from 'fastify';
import { createAuditContextHook } from '../../src/fastify';
import { auditTrailPlugin } from '../../src/plugin/audit_trail_plugin';
import { registerAuditSources, resetAuditSources, resetAuditContextResolver } from '../../src/context/user_context';
import { HISTORY_COLLECTION, clean_history, make_schema, model_for, read_history, start_db, stop_db } from '../helpers/db';

jest.setTimeout(120000);

const user_header_id = '64e5faee64e5faee64e5faee';

describe('Fastify integration', () => {
    let fastify: ReturnType<typeof Fastify>;
    let Model: any;

    beforeAll(async () => {
        await start_db();
        const schema = make_schema();
        schema.plugin(auditTrailPlugin, { historyCollectionName: HISTORY_COLLECTION });
        Model = model_for(schema, 'FastifyAudit');

        fastify = Fastify();
        // mimics an auth plugin parsing the `user` header into request.user
        fastify.addHook('onRequest', (req: any, _reply: any, done: () => void) => {
            const raw = req.headers['user'];
            if (raw) {
                try {
                    req.user = JSON.parse(raw);
                } catch {
                    req.user = undefined;
                }
            }
            done();
        });
        fastify.addHook('onRequest', createAuditContextHook());

        fastify.post('/docs', async (req: any) => {
            const doc = await Model.create({ name: (req.body as any).name });
            return { id: String(doc._id) };
        });

        fastify.post('/docs-custom', async (req: any) => {
            const doc = await Model.create({ name: (req.body as any).name });
            return { id: String(doc._id) };
        });

        await fastify.ready();
    });

    afterAll(async () => {
        await fastify.close();
        await stop_db();
    });

    beforeEach(async () => {
        resetAuditContextResolver();
        resetAuditSources();
        await clean_history();
    });

    it('writes history with modified_by from request.user._id', async () => {
        const res = await fastify.inject({
            method: 'POST',
            url: '/docs',
            headers: { user: JSON.stringify({ _id: user_header_id }) },
            payload: { name: 'fastify-doc' },
        });
        expect(res.statusCode).toBe(200);

        const records = await read_history({ action: 'created' });
        expect(records).toHaveLength(1);
        expect(String(records[0].modified_by)).toBe(user_header_id);
        expect(records[0].source).toBe('http');
        expect(records[0].changes.name.new).toBe('fastify-doc');
    });

    it('modified_by is null when the request carries no user', async () => {
        const res = await fastify.inject({ method: 'POST', url: '/docs', payload: { name: 'anon' } });
        expect(res.statusCode).toBe(200);

        const [record] = await read_history({ action: 'created' });
        expect(record.modified_by).toBeNull();
    });

    it('context survives async handler continuations (lazy queries)', async () => {
        const res = await fastify.inject({
            method: 'POST',
            url: '/docs',
            headers: { user: JSON.stringify({ _id: user_header_id }) },
            payload: { name: 'lazy' },
        });
        expect(res.statusCode).toBe(200);

        const [record] = await read_history({ action: 'created' });
        expect(String(record.modified_by)).toBe(user_header_id);
    });

    it('concurrent requests keep their own user ids', async () => {
        const user_x = '111111111111111111111111';
        const user_y = '222222222222222222222222';
        await Promise.all([
            fastify.inject({
                method: 'POST',
                url: '/docs',
                headers: { user: JSON.stringify({ _id: user_x }) },
                payload: { name: 'x' },
            }),
            fastify.inject({
                method: 'POST',
                url: '/docs',
                headers: { user: JSON.stringify({ _id: user_y }) },
                payload: { name: 'y' },
            }),
        ]);

        const records = await read_history({ action: 'created' });
        expect(records).toHaveLength(2);
        const by_name = new Map(records.map((r: any) => [r.changes.name.new, String(r.modified_by)]));
        expect(by_name.get('x')).toBe(user_x);
        expect(by_name.get('y')).toBe(user_y);
    });

    it('custom getModifiedBy extracts the person who changed the data', async () => {
        const custom_fastify = Fastify();
        custom_fastify.addHook(
            'onRequest',
            createAuditContextHook({
                getModifiedBy: (req: any) => req.headers['x-account-id'],
            }),
        );
        custom_fastify.post('/docs', async (req: any) => {
            await Model.create({ name: (req.body as any).name });
            return { ok: true };
        });
        await custom_fastify.ready();

        await custom_fastify.inject({
            method: 'POST',
            url: '/docs',
            headers: { 'x-account-id': user_header_id },
            payload: { name: 'custom' },
        });

        const [record] = await read_history({ action: 'created' });
        expect(String(record.modified_by)).toBe(user_header_id);
        await custom_fastify.close();
    });

    it('uses the default http channel when no source option is given', async () => {
        await fastify.inject({ method: 'POST', url: '/docs', payload: { name: 'init' } });
        const [record] = await read_history({ action: 'created' });
        expect(record.source).toBe('http');
    });

    it('registered custom source is accepted', async () => {
        registerAuditSources('kafka');

        const kafka_fastify = Fastify();
        kafka_fastify.addHook('onRequest', createAuditContextHook({ source: 'kafka' }));
        kafka_fastify.post('/docs', async () => {
            await Model.create({ name: 'kafka-doc' });
            return { ok: true };
        });
        await kafka_fastify.ready();

        await kafka_fastify.inject({ method: 'POST', url: '/docs', payload: {} });

        const [record] = await read_history({ action: 'created' });
        expect(record.source).toBe('kafka');
        await kafka_fastify.close();
    });

    it('rejects an unregistered source', async () => {
        const bad_fastify = Fastify();
        bad_fastify.addHook('onRequest', createAuditContextHook({ source: 'nope' }));
        bad_fastify.post('/docs', async () => ({ ok: true }));
        await bad_fastify.ready();

        const res = await bad_fastify.inject({ method: 'POST', url: '/docs', payload: {} });
        expect(res.statusCode).toBe(500);
        expect(await read_history()).toHaveLength(0);
        await bad_fastify.close();
    });
});
