import { Types } from 'mongoose';
import { AuditChange } from '../context/types';

const DEFAULT_OMIT_PATHS = ['__v'];

function is_object_id(value: any): boolean {
    return value instanceof Types.ObjectId || value?._bsontype === 'ObjectId' || value?._bsontype === 'ObjectID';
}

function is_plain_object(value: any): boolean {
    return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date) && !is_object_id(value);
}

const WILDCARD = '*';
const ANCHOR = '^';

/**
 * Omit rules:
 * - an exact path match prunes the whole subtree (supports custom dot-notation paths);
 * - an anchored path (`^name`) prunes that key only at the document root, keeping
 *   nested occurrences (e.g. `_id` of subdocuments/array elements);
 * - a simple (dot-less) name in the omit set prunes that key at any nesting level
 *   (e.g. nested `_id`/`__v`/timestamps inside subdocuments);
 * - a wildcard segment (`*`) in a dot-notation path matches any single segment,
 *   e.g. `list.*.secret` prunes `secret` in every element of `list`.
 */
function matches_wildcard(segments: string[], pattern: string[]): boolean {
    if (segments.length !== pattern.length) {
        return false;
    }
    return pattern.every((part, i) => part === WILDCARD || part === segments[i]);
}

function is_omitted_path(path: string, omit: Set<string>, omit_top_level: Set<string>, wildcards: string[][]): boolean {
    if (!path) {
        return false;
    }
    if (omit.has(path)) {
        return true;
    }
    const segments = path.split('.');
    if (segments.some(segment => omit_top_level.has(segment))) {
        return true;
    }
    return wildcards.some(pattern => matches_wildcard(segments, pattern));
}

/**
 * Returns a copy of `value` with omitted paths removed. Applied to both
 * snapshots before diffing so that omit rules reach any depth, including keys
 * inside array elements and arrays added/removed as a whole.
 */
function strip_omitted(value: any, path: string, omit: Set<string>, omit_top_level: Set<string>, wildcards: string[][]): any {
    if (is_omitted_path(path, omit, omit_top_level, wildcards)) {
        return undefined;
    }
    if (Array.isArray(value)) {
        return value.map((item, i) => strip_omitted(item, `${path}.${i}`, omit, omit_top_level, wildcards));
    }
    if (is_plain_object(value)) {
        const result: Record<string, any> = {};
        for (const key of Object.keys(value)) {
            const child_path = path ? `${path}.${key}` : key;
            if (!is_omitted_path(child_path, omit, omit_top_level, wildcards)) {
                result[key] = strip_omitted(value[key], child_path, omit, omit_top_level, wildcards);
            }
        }
        return result;
    }
    return value;
}

function leaf_equals(a: any, b: any): boolean {
    if (is_object_id(a) || is_object_id(b)) {
        return is_object_id(a) && is_object_id(b) && String(a) === String(b);
    }
    if (a instanceof Date || b instanceof Date) {
        return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
    }
    return Object.is(a, b);
}

function value_equals(a: any, b: any): boolean {
    if (is_plain_object(a) && is_plain_object(b)) {
        const a_keys = Object.keys(a);
        const b_keys = Object.keys(b);
        if (a_keys.length !== b_keys.length) {
            return false;
        }
        return a_keys.every(key => value_equals(a[key], b[key]));
    }
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) {
            return false;
        }
        for (let i = 0; i < a.length; i++) {
            if (!value_equals(a[i], b[i])) {
                return false;
            }
        }
        return true;
    }
    return leaf_equals(a, b);
}

/**
 * Keys an array by element `_id`. Returns `null` when the array cannot be keyed:
 * a non-object element, a missing `_id` or a duplicate `_id` makes per-element
 * diffing impossible.
 */
function key_elements_by_id(array: any[]): Map<string, any> | null {
    const by_id = new Map<string, any>();
    for (const element of array) {
        if (!is_plain_object(element) || element._id === null || element._id === undefined) {
            return null;
        }
        const key = String(element._id);
        if (by_id.has(key)) {
            return null;
        }
        by_id.set(key, element);
    }
    return by_id;
}

/**
 * Diffs two arrays whose elements are subdocuments keyed by `_id` and returns only
 * the elements that changed, were added or were removed — not the whole array.
 * Both returned arrays keep their original relative order, so consumers pair
 * elements by `_id` and can tell removed (`old` only), added (`new` only) and
 * modified (both sides) apart.
 *
 * Returns `null` when per-element diffing does not apply and the caller must keep
 * the whole array as the delta:
 * - any element on either side is not a plain object with an `_id`, or `_id`s are
 *   not unique within an array;
 * - the elements present on both sides moved relative to each other (a pure reorder
 *   or a reorder that came with a change) — order is part of the array value, and a
 *   shrunken delta alone cannot express it.
 *
 * Added and removed elements are reported without their position: the shrink says
 * what entered and what left, not where it sat. Callers that need the exact array
 * before and after have the full snapshots in `old_document`/`current_document`.
 */
export function diff_elements_by_id(old_array: any[], new_array: any[]): AuditChange | null {
    const old_by_key = key_elements_by_id(old_array);
    const new_by_key = key_elements_by_id(new_array);
    if (!old_by_key || !new_by_key) {
        return null;
    }

    const common_ids = (array: any[], keep: Map<string, any>) =>
        array.filter(element => keep.has(String(element._id))).map(element => String(element._id));
    const old_order = common_ids(old_array, new_by_key);
    const new_order = common_ids(new_array, old_by_key);
    if (old_order.some((id, index) => id !== new_order[index])) {
        return null;
    }

    const changed_old: any[] = [];
    const changed_new: any[] = [];

    for (const element of old_array) {
        const counterpart = new_by_key.get(String(element._id));
        // Missing on the new side means removed, present but different means modified.
        if (counterpart && value_equals(element, counterpart)) {
            continue;
        }
        changed_old.push(element);
    }

    for (const element of new_array) {
        const counterpart = old_by_key.get(String(element._id));
        // Missing on the old side means added, present but different means modified.
        if (counterpart && value_equals(counterpart, element)) {
            continue;
        }
        changed_new.push(element);
    }

    if (!changed_old.length && !changed_new.length) {
        return null;
    }
    return { old: changed_old, new: changed_new };
}

export function deep_diff(old_object: any, new_object: any, omit_paths: string[] = [], prefix = ''): Record<string, AuditChange> | null {
    const raw_paths = [...new Set([...DEFAULT_OMIT_PATHS, ...omit_paths])];
    const anchored = raw_paths.filter(path => path.startsWith(ANCHOR)).map(path => path.slice(ANCHOR.length));
    const free = raw_paths.filter(path => !path.startsWith(ANCHOR));
    // Anchored paths match by exact path only, so they never reach nested levels.
    const omit = new Set([...free, ...anchored.filter(Boolean)]);
    const omit_top_level = new Set(free.filter(path => !path.includes('.')));
    const wildcards = free.filter(path => path.includes('.') && path.split('.').includes(WILDCARD)).map(path => path.split('.'));

    const old_stripped = strip_omitted(old_object ?? {}, '', omit, omit_top_level, wildcards);
    const new_stripped = strip_omitted(new_object ?? {}, '', omit, omit_top_level, wildcards);

    const changes: Record<string, AuditChange> = {};

    const walk = (old_value: any, new_value: any, path: string) => {
        if (is_plain_object(old_value) && is_plain_object(new_value)) {
            const keys = new Set([...Object.keys(old_value), ...Object.keys(new_value)]);
            for (const key of keys) {
                const child_path = path ? `${path}.${key}` : key;
                walk(old_value[key], new_value[key], child_path);
            }
            return;
        }

        if (Array.isArray(old_value) && Array.isArray(new_value)) {
            if (value_equals(old_value, new_value)) {
                return;
            }
            // Subdocument arrays shrink to the elements that really changed; anything
            // else (primitive arrays, duplicates, a pure reorder) keeps the whole array.
            changes[path || '.'] = diff_elements_by_id(old_value, new_value) ?? { old: old_value, new: new_value };
            return;
        }

        if (!leaf_equals(old_value, new_value)) {
            changes[path || '.'] = { old: old_value, new: new_value };
        }
    };

    walk(old_stripped, new_stripped, prefix);

    return Object.keys(changes).length ? changes : null;
}
