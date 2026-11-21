import { Types } from 'mongoose';
import { deep_diff, diff_elements_by_id } from '../../src/plugin/deep_diff';

const oid = (hex: string) => new Types.ObjectId(hex);

describe('deep_diff', () => {
    describe('value types', () => {
        it('returns null when ObjectIds are equal', () => {
            const value = '64f0a1c2cf6d2db7f599b212';
            expect(deep_diff({ id: oid(value) }, { id: oid(value) })).toBeNull();
        });

        it('stores ObjectIds as ObjectId when changed', () => {
            const oldId = oid('64f0a1c2cf6d2db7f599b212');
            const newId = oid('64f0a1c2cf6d2db7f599b213');
            expect(deep_diff({ id: oldId }, { id: newId })).toEqual({
                id: { old: oldId, new: newId },
            });
        });

        it('returns null when Dates are equal', () => {
            expect(deep_diff({ d: new Date(1_700_000_000_000) }, { d: new Date(1_700_000_000_000) })).toBeNull();
        });

        it('stores Dates as Date when changed', () => {
            expect(deep_diff({ d: new Date(1_000) }, { d: new Date(2_000) })).toEqual({
                d: { old: new Date(1_000), new: new Date(2_000) },
            });
        });

        it('compares Dates inside array elements by value', () => {
            const stamp = 1_700_000_000_000;
            const diff = deep_diff({ list: [{ d: new Date(stamp) }] }, { list: [{ d: new Date(stamp) }] });
            expect(diff).toBeNull();
        });

        it('compares ObjectIds inside nested objects by value', () => {
            const value = '64f0a1c2cf6d2db7f599b212';
            const diff = deep_diff({ sub: { id: oid(value) } }, { sub: { id: oid(value) } });
            expect(diff).toBeNull();
        });
    });

    describe('nested fields', () => {
        it('uses dot-notation paths', () => {
            expect(deep_diff({ a: { b: 1 } }, { a: { b: 2 } })).toEqual({ 'a.b': { old: 1, new: 2 } });
        });

        it('stores Dates in a nested object as Date', () => {
            const oldDate = new Date('2026-09-01T00:00:00.000Z');
            const newDate = new Date('2026-10-01T00:00:00.000Z');
            expect(deep_diff({ sub: { valid_period: oldDate } }, { sub: { valid_period: newDate } })).toEqual({
                'sub.valid_period': { old: oldDate, new: newDate },
            });
        });

        it('detects added and removed fields', () => {
            expect(deep_diff({}, { a: 1 })).toEqual({ a: { old: undefined, new: 1 } });
            expect(deep_diff({ a: 1 }, {})).toEqual({ a: { old: 1, new: undefined } });
        });
    });

    describe('arrays', () => {
        it('returns null for equal arrays (different references)', () => {
            expect(deep_diff({ list: [1, 2] }, { list: [1, 2] })).toBeNull();
        });

        it('stores the whole array when it differs', () => {
            expect(deep_diff({ list: [1, 2] }, { list: [1, 3] })).toEqual({ list: { old: [1, 2], new: [1, 3] } });
        });

        it('stores Dates inside an array element as Date', () => {
            const oldDate = new Date('2026-09-01T00:00:00.000Z');
            const newDate = new Date('2026-10-01T00:00:00.000Z');
            const diff = deep_diff({ list: [{ valid_period: oldDate, priority: 1 }] }, { list: [{ valid_period: newDate, priority: 1 }] });
            expect(diff).toEqual({
                list: { old: [{ valid_period: oldDate, priority: 1 }], new: [{ valid_period: newDate, priority: 1 }] },
            });
        });

        it('compares arrays of objects element-wise for equality', () => {
            expect(deep_diff({ list: [{ a: 1 }] }, { list: [{ a: 1 }] })).toBeNull();
        });

        it('omits nested keys inside array elements when only those keys differ', () => {
            const diff = deep_diff(
                { list: [{ _id: oid('64f0a1c2cf6d2db7f599b212'), name: 'a' }] },
                { list: [{ _id: oid('64f0a1c2cf6d2db7f599b213'), name: 'a' }] },
                ['_id'],
            );
            expect(diff).toBeNull();
        });

        it('omits nested keys inside array elements while keeping other changes', () => {
            const diff = deep_diff(
                { list: [{ _id: oid('64f0a1c2cf6d2db7f599b212'), name: 'a' }] },
                { list: [{ _id: oid('64f0a1c2cf6d2db7f599b213'), name: 'b' }] },
                ['_id'],
            );
            expect(diff).toEqual({
                list: { old: [{ name: 'a' }], new: [{ name: 'b' }] },
            });
        });

        it('omits nested keys inside an array added as a whole (created)', () => {
            expect(deep_diff({}, { list: [{ secret: 1, keep: 2 }] }, ['secret'])).toEqual({
                list: { old: undefined, new: [{ keep: 2 }] },
            });
        });

        it('omits nested keys inside an array removed as a whole (deleted)', () => {
            expect(deep_diff({ list: [{ secret: 1, keep: 2 }] }, {}, ['secret'])).toEqual({
                list: { old: [{ keep: 2 }], new: undefined },
            });
        });

        it('omits nested keys inside a newly added array field', () => {
            expect(deep_diff({ a: 1 }, { a: 1, list: [{ secret: 1 }] }, ['secret'])).toEqual({
                list: { old: undefined, new: [{}] },
            });
        });

        it('omits default service fields inside an array added as a whole', () => {
            expect(deep_diff({}, { list: [{ __v: 0, name: 'a' }] })).toEqual({
                list: { old: undefined, new: [{ name: 'a' }] },
            });
        });

        it('omits array element keys via a wildcard path', () => {
            const diff = deep_diff({ list: [{ secret: 1, keep: 1 }] }, { list: [{ secret: 2, keep: 2 }] }, ['list.*.secret']);
            expect(diff).toEqual({ list: { old: [{ keep: 1 }], new: [{ keep: 2 }] } });
        });

        it('omits wildcard paths inside arrays added as a whole', () => {
            expect(deep_diff({}, { list: [{ secret: 1, keep: 2 }] }, ['list.*.secret'])).toEqual({
                list: { old: undefined, new: [{ keep: 2 }] },
            });
        });

        it('does not treat an index-less dotted path as a wildcard', () => {
            const diff = deep_diff({ list: [{ secret: 1 }] }, { list: [{ secret: 2 }] }, ['list.secret']);
            expect(diff).toEqual({ list: { old: [{ secret: 1 }], new: [{ secret: 2 }] } });
        });
    });

    describe('id-keyed element arrays', () => {
        const e1 = oid('64f0a1c2cf6d2db7f599b211');
        const e2 = oid('64f0a1c2cf6d2db7f599b212');
        const e3 = oid('64f0a1c2cf6d2db7f599b213');

        it('stores only the element that was added, not the unchanged ones', () => {
            const a = { _id: e1, priority: 100 };
            const b = { _id: e2, priority: 200 };
            const c = { _id: e3, priority: 300 };
            expect(deep_diff({ assignments: [a, b] }, { assignments: [a, b, c] })).toEqual({
                assignments: { old: [], new: [c] },
            });
        });

        it('stores only the element that was modified', () => {
            expect(
                deep_diff(
                    {
                        assignments: [
                            { _id: e1, priority: 100 },
                            { _id: e2, priority: 200 },
                        ],
                    },
                    {
                        assignments: [
                            { _id: e1, priority: 150 },
                            { _id: e2, priority: 200 },
                        ],
                    },
                ),
            ).toEqual({
                assignments: { old: [{ _id: e1, priority: 100 }], new: [{ _id: e1, priority: 150 }] },
            });
        });

        it('stores only the element that was removed', () => {
            expect(
                deep_diff(
                    {
                        assignments: [
                            { _id: e1, priority: 100 },
                            { _id: e2, priority: 200 },
                        ],
                    },
                    { assignments: [{ _id: e1, priority: 100 }] },
                ),
            ).toEqual({
                assignments: { old: [{ _id: e2, priority: 200 }], new: [] },
            });
        });

        it('stores the changed element as a whole, not per field', () => {
            const a = { _id: e1, blocks: [oid('64f0a1c2cf6d2db7f599b215')], priority: 100 };
            const b = { _id: e2, blocks: [oid('64f0a1c2cf6d2db7f599b216')], priority: 200 };
            const aChanged = { _id: e1, blocks: [oid('64f0a1c2cf6d2db7f599b215'), oid('64f0a1c2cf6d2db7f599b217')], priority: 100 };
            expect(deep_diff({ assignments: [a, b] }, { assignments: [aChanged, b] })).toEqual({
                assignments: { old: [a], new: [aChanged] },
            });
        });

        it('keeps the whole array when elements carry no _id', () => {
            expect(deep_diff({ list: [{ a: 1 }] }, { list: [{ a: 2 }] })).toEqual({
                list: { old: [{ a: 1 }], new: [{ a: 2 }] },
            });
        });

        it('keeps the whole array when _id values are not unique', () => {
            const a = { _id: e1, priority: 100 };
            const aChanged = { _id: e1, priority: 150 };
            expect(deep_diff({ list: [a, a] }, { list: [aChanged, a] })).toEqual({
                list: { old: [a, a], new: [aChanged, a] },
            });
        });

        it('keeps the whole array on a pure reorder', () => {
            const a = { _id: e1, priority: 100 };
            const b = { _id: e2, priority: 200 };
            expect(deep_diff({ list: [a, b] }, { list: [b, a] })).toEqual({
                list: { old: [a, b], new: [b, a] },
            });
        });

        it('keeps the whole array when a reorder comes together with a change', () => {
            const a = { _id: e1, priority: 100 };
            const b = { _id: e2, priority: 200 };
            const bChanged = { _id: e2, priority: 999 };
            expect(deep_diff({ list: [a, b] }, { list: [bChanged, a] })).toEqual({
                list: { old: [a, b], new: [bChanged, a] },
            });
        });

        it('detects a reorder regardless of the characters inside _id', () => {
            // Any stringified sequence would collapse these two orders into one value,
            // so the order check has to compare element-wise.
            const a = { _id: '||', priority: 1 };
            const b = { _id: '|', priority: 2 };
            const bChanged = { _id: '|', priority: 99 };
            expect(deep_diff({ list: [a, b] }, { list: [bChanged, a] })).toEqual({
                list: { old: [a, b], new: [bChanged, a] },
            });
        });

        it('diff_elements_by_id reports removed, modified and added elements', () => {
            const removed = { _id: e1, priority: 1 };
            const modified = { _id: e2, priority: 2 };
            const modifiedAfter = { _id: e2, priority: 9 };
            const added = { _id: e3, priority: 3 };
            expect(diff_elements_by_id([removed, modified], [modifiedAfter, added])).toEqual({
                old: [removed, modified],
                new: [modifiedAfter, added],
            });
        });

        it('diff_elements_by_id returns null when per-element diffing does not apply', () => {
            const a = { _id: e1, priority: 100 };
            const b = { _id: e2, priority: 200 };
            expect(diff_elements_by_id([1, 2], [1, 3])).toBeNull();
            expect(diff_elements_by_id([a], [a])).toBeNull();
            expect(diff_elements_by_id([a, b], [b, a])).toBeNull();
            expect(diff_elements_by_id([a, b], [{ _id: e2, priority: 9 }, a])).toBeNull();
            expect(diff_elements_by_id([a, a], [{ _id: e1, priority: 150 }, a])).toBeNull();
        });
    });

    describe('omit', () => {
        it('omits a service field at the top level by default', () => {
            expect(deep_diff({ a: 1, __v: 1 }, { a: 1, __v: 2 })).toBeNull();
        });

        it('omits a service field at any nesting level', () => {
            expect(deep_diff({ sub: { __v: 1, name: 'a' } }, { sub: { __v: 2, name: 'a' } })).toBeNull();
        });

        it('omits a nested field when its name is passed in omitPaths', () => {
            const diff = deep_diff(
                { sub: { _id: oid('64f0a1c2cf6d2db7f599b212'), name: 'a' } },
                { sub: { _id: oid('64f0a1c2cf6d2db7f599b213'), name: 'a' } },
                ['_id'],
            );
            expect(diff).toBeNull();
        });

        it('omits a custom dot-notation path exactly', () => {
            const diff = deep_diff({ sub: { secret: 1, keep: 1 } }, { sub: { secret: 2, keep: 2 } }, ['sub.secret']);
            expect(diff).toEqual({ 'sub.keep': { old: 1, new: 2 } });
        });
    });

    describe('anchored omit (^)', () => {
        it('omits only the root _id and returns null when nothing else changed', () => {
            const diff = deep_diff(
                { _id: oid('64f0a1c2cf6d2db7f599b212'), sub: { _id: oid('64f0a1c2cf6d2db7f599b213'), name: 'a' } },
                { _id: oid('64f0a1c2cf6d2db7f599b214'), sub: { _id: oid('64f0a1c2cf6d2db7f599b213'), name: 'a' } },
                ['^_id'],
            );
            expect(diff).toBeNull();
        });

        it('keeps the _id of array elements so the edited element is identifiable', () => {
            const diff = deep_diff(
                { list: [{ _id: oid('64f0a1c2cf6d2db7f599b212'), name: 'x' }] },
                { list: [{ _id: oid('64f0a1c2cf6d2db7f599b213'), name: 'x' }] },
                ['^_id'],
            );
            expect(diff).toEqual({
                list: {
                    old: [{ _id: oid('64f0a1c2cf6d2db7f599b212'), name: 'x' }],
                    new: [{ _id: oid('64f0a1c2cf6d2db7f599b213'), name: 'x' }],
                },
            });
        });

        it('keeps nested _id changes while omitting the root _id', () => {
            const diff = deep_diff(
                { _id: oid('64f0a1c2cf6d2db7f599b212'), sub: { _id: oid('64f0a1c2cf6d2db7f599b213'), name: 'a' } },
                { _id: oid('64f0a1c2cf6d2db7f599b214'), sub: { _id: oid('64f0a1c2cf6d2db7f599b215'), name: 'a' } },
                ['^_id'],
            );
            expect(diff).toEqual({
                'sub._id': { old: oid('64f0a1c2cf6d2db7f599b213'), new: oid('64f0a1c2cf6d2db7f599b215') },
            });
        });
    });

    it('returns null for an empty delta', () => {
        expect(deep_diff({ a: 1 }, { a: 1 })).toBeNull();
    });
});
