import { collect_update_paths, filter_changes_by_paths, has_only_plain_fields, is_path_affected } from '../../src/plugin/helpers';

describe('has_only_plain_fields', () => {
    it('is true for plain fields and an empty update', () => {
        expect(has_only_plain_fields({ a: 1, b: 2 })).toBe(true);
        expect(has_only_plain_fields({})).toBe(true);
    });

    it('is false when operators are present', () => {
        expect(has_only_plain_fields({ $set: { a: 1 } })).toBe(false);
    });

    it('is false for arrays (aggregation pipelines) and non-objects', () => {
        expect(has_only_plain_fields([{ $set: { a: 1 } }] as any)).toBe(false);
        expect(has_only_plain_fields(null as any)).toBe(false);
        expect(has_only_plain_fields(undefined as any)).toBe(false);
    });
});

describe('collect_update_paths', () => {
    it('collects operator paths', () => {
        const paths = collect_update_paths({ $set: { a: 1, 'b.c': 2 }, $unset: { d: '' }, $inc: { e: 1 } });
        expect(paths).toEqual(new Set(['a', 'b.c', 'd', 'e']));
    });

    it('collects plain field paths', () => {
        expect(collect_update_paths({ a: 1, b: 2 })).toEqual(new Set(['a', 'b']));
    });

    it('ignores $setOnInsert', () => {
        expect(collect_update_paths({ $setOnInsert: { _id: 'x' } })).toBeNull();
    });

    it('returns null for aggregation pipeline updates', () => {
        expect(collect_update_paths([{ $set: { a: 1 } }])).toBeNull();
    });

    it('returns null for empty or missing updates', () => {
        expect(collect_update_paths({})).toBeNull();
        expect(collect_update_paths(null)).toBeNull();
        expect(collect_update_paths(undefined)).toBeNull();
    });
});

describe('is_path_affected', () => {
    it('matches exact, nested and parent paths', () => {
        expect(is_path_affected('a', new Set(['a']))).toBe(true);
        expect(is_path_affected('a.b', new Set(['a']))).toBe(true);
        expect(is_path_affected('a', new Set(['a.b']))).toBe(true);
        expect(is_path_affected('a', new Set(['b']))).toBe(false);
    });

    it('treats a missing allowed set as "everything is allowed"', () => {
        expect(is_path_affected('a', null)).toBe(true);
        expect(is_path_affected('a', undefined)).toBe(true);
    });
});

describe('filter_changes_by_paths', () => {
    const changes = { a: { old: 1, new: 2 }, b: { old: 1, new: 2 } };

    it('keeps only affected changes', () => {
        expect(filter_changes_by_paths(changes, new Set(['a']))).toEqual({ a: changes.a });
    });

    it('returns changes untouched when no filter is provided', () => {
        expect(filter_changes_by_paths(changes, null)).toBe(changes);
    });
});
