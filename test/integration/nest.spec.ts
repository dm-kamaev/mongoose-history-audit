import 'reflect-metadata';
import { Controller, Get, INestApplication, Post, Body, Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AuditTrail, AuditTrailInterceptor, AuditContext, createAuditContextDecorator } from '../../src/nest';
import { auditTrailPlugin } from '../../src/plugin/audit_trail_plugin';
import { isAuditEnabled, getAuditUserId, getAuditInitiator } from '../../src/context/user_context';
import { HISTORY_COLLECTION, clean_history, make_schema, model_for, read_history, start_db, stop_db } from '../helpers/db';

jest.setTimeout(120000);

const user_header_id = '64e5faee64e5faee64e5faee';

// userland preset, as documented in the README
const KafkaAuditContext = createAuditContextDecorator({ initiator: 'kafka' });

// mimics a gateway guard that parses the `user` header into request.user
@Injectable()
class FakeGatewayGuard implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
        if (context.getType() !== 'http') {
            return true;
        }
        const req = context.switchToHttp().getRequest();
        const raw = req.headers['user'];
        if (raw) {
            try {
                req.user = JSON.parse(raw);
            } catch {
                req.user = undefined;
            }
        }
        return true;
    }
}

let create_doc_model: () => any;

@Injectable()
class TestService {
    async create_doc(name: string) {
        const Model = (create_doc_model as any)();
        return Model.create({ name });
    }

    async read_context() {
        return { enabled: isAuditEnabled(), userId: String(getAuditUserId() ?? ''), initiator: getAuditInitiator() };
    }
}

@Controller()
class TestController {
    constructor(private readonly service: TestService) {}

    @Post('docs')
    @AuditTrail()
    async create(@Body('name') name: string) {
        const doc = await this.service.create_doc(name);
        return { id: String(doc._id) };
    }

    @Post('docs-no-audit')
    async create_without_audit(@Body('name') name: string) {
        const doc = await this.service.create_doc(name);
        return { id: String(doc._id) };
    }

    @Get('context')
    @AuditTrail()
    async context() {
        return this.service.read_context();
    }

    @Get('context-no-audit')
    async context_without_audit() {
        return this.service.read_context();
    }

    @Post('docs-custom-user')
    @AuditTrail({ getUserId: () => user_header_id })
    async create_custom_user(@Body('name') name: string) {
        const doc = await this.service.create_doc(name);
        return { id: String(doc._id) };
    }

    @Post('cron-doc')
    @AuditContext({ initiator: 'cron' })
    async create_via_cron_decorator(@Body('name') name: string) {
        const doc = await this.service.create_doc(name);
        return { id: String(doc._id) };
    }

    @Post('kafka-doc')
    @KafkaAuditContext()
    async create_via_preset(@Body('name') name: string) {
        const doc = await this.service.create_doc(name);
        return { id: String(doc._id) };
    }
}

describe('NestJS integration (supertest)', () => {
    let app: INestApplication;

    beforeAll(async () => {
        await start_db();
        const schema = make_schema();
        schema.plugin(auditTrailPlugin, { historyCollectionName: HISTORY_COLLECTION });
        create_doc_model = () => model_for(schema, 'NestAudit');

        const module_ref = await Test.createTestingModule({
            controllers: [TestController],
            providers: [TestService, AuditTrailInterceptor, FakeGatewayGuard],
        }).compile();

        app = module_ref.createNestApplication();
        app.useGlobalGuards(app.get(FakeGatewayGuard));
        app.useGlobalInterceptors(app.get(AuditTrailInterceptor));
        await app.init();
    });

    afterAll(async () => {
        await app.close();
        await stop_db();
    });

    beforeEach(async () => {
        await clean_history();
    });

    it('writes history with modified_by from request.user._id', async () => {
        const res = await request(app.getHttpServer())
            .post('/docs')
            .set('user', JSON.stringify({ _id: user_header_id }))
            .send({ name: 'nest-doc' });
        expect(res.status).toBe(201);

        const records = await read_history({ action: 'created' });
        expect(records).toHaveLength(1);
        expect(String(records[0].modified_by)).toBe(user_header_id);
        expect(records[0].initiator).toBe('http');
        expect(records[0].changes.name.new).toBe('nest-doc');
    });

    it('modified_by is null when the request carries no user', async () => {
        const res = await request(app.getHttpServer()).post('/docs').send({ name: 'anon' });
        expect(res.status).toBe(201);

        const [record] = await read_history({ action: 'created' });
        expect(record.modified_by).toBeNull();
    });

    it('writes no history for handlers without @AuditTrail', async () => {
        const res = await request(app.getHttpServer())
            .post('/docs-no-audit')
            .set('user', JSON.stringify({ _id: user_header_id }))
            .send({ name: 'skipped' });
        expect(res.status).toBe(201);

        expect(await read_history()).toHaveLength(0);
    });

    it('context is enabled inside @AuditTrail handler', async () => {
        const res = await request(app.getHttpServer())
            .get('/context')
            .set('user', JSON.stringify({ _id: user_header_id }));
        expect(res.body).toEqual({ enabled: true, userId: user_header_id, initiator: 'http' });
    });

    it('context is disabled outside @AuditTrail handler (no leak between requests)', async () => {
        await request(app.getHttpServer()).get('/context'); // warm: previous request enabled
        const res = await request(app.getHttpServer()).get('/context-no-audit');
        expect(res.body.enabled).toBe(false);
    });

    it('custom getUserId option overrides request.user extraction', async () => {
        await request(app.getHttpServer())
            .post('/docs-custom-user')
            .set('user', JSON.stringify({ _id: '000000000000000000000000' }))
            .send({ name: 'custom' });

        const [record] = await read_history({ action: 'created' });
        expect(String(record.modified_by)).toBe(user_header_id);
    });

    it('@AuditContext sets initiator for CLI-style handlers', async () => {
        await request(app.getHttpServer()).post('/cron-doc').send({ name: 'cron-doc' });

        const [record] = await read_history({ action: 'created' });
        expect(record.initiator).toBe('cron');
        expect(record.modified_by).toBeNull(); // system record
    });

    it('createAuditContextDecorator preset bakes in the initiator', async () => {
        await request(app.getHttpServer()).post('/kafka-doc').send({ name: 'kafka-doc' });

        const [record] = await read_history({ action: 'created' });
        expect(record.initiator).toBe('kafka');
    });

    it('concurrent requests keep their own user ids', async () => {
        const user_x = '111111111111111111111111';
        const user_y = '222222222222222222222222';
        await Promise.all([
            request(app.getHttpServer())
                .post('/docs')
                .set('user', JSON.stringify({ _id: user_x }))
                .send({ name: 'concurrent-x' }),
            request(app.getHttpServer())
                .post('/docs')
                .set('user', JSON.stringify({ _id: user_y }))
                .send({ name: 'concurrent-y' }),
        ]);

        const records = await read_history({ action: 'created' });
        expect(records).toHaveLength(2);
        const by_name = new Map(records.map((r: any) => [r.changes.name.new, String(r.modified_by)]));
        expect(by_name.get('concurrent-x')).toBe(user_x);
        expect(by_name.get('concurrent-y')).toBe(user_y);
    });
});
