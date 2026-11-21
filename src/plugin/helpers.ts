export function has_only_plain_fields(update: Record<string, any>): boolean {
    if (!update || typeof update !== 'object' || Array.isArray(update)) {
        return false;
    }
    return Object.keys(update).every(key => !key.startsWith('$'));
}

/**
 * Collects the set of document paths an update object can touch.
 * Returns `null` when paths cannot be determined (e.g. aggregation pipeline
 * updates or non-object updates) — in that case callers must not filter.
 */
export function collect_update_paths(update: any): Set<string> | null {
    if (!update || typeof update !== 'object' || Array.isArray(update)) {
        return null;
    }

    const keys = Object.keys(update);
    const operator_keys = keys.filter(key => key.startsWith('$'));

    if (!operator_keys.length) {
        return keys.length ? new Set(keys) : null;
    }

    const paths = new Set<string>();
    for (const operator of operator_keys) {
        if (operator === '$setOnInsert') {
            continue;
        }
        const fields = update[operator];
        if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
            continue;
        }
        for (const key of Object.keys(fields)) {
            paths.add(key);
        }
    }

    return paths.size ? paths : null;
}

/**
 * A change path is considered affected if it matches an allowed path, is nested
 * under it, or is a parent of it (deep_diff may report a whole subtree).
 */
export function is_path_affected(change_path: string, allowed_paths: Set<string> | null | undefined): boolean {
    if (!allowed_paths) {
        return true;
    }
    for (const path of allowed_paths) {
        if (change_path === path || change_path.startsWith(`${path}.`) || path.startsWith(`${change_path}.`)) {
            return true;
        }
    }
    return false;
}

/**
 * Drops changes that the operation could not have produced. This removes
 * concurrent modifications of unrelated fields from the delta (partial TOCTOU
 * mitigation); changes to the same field still follow last-writer-wins.
 */
export function filter_changes_by_paths(changes: Record<string, any>, allowed_paths: Set<string> | null | undefined): Record<string, any> {
    if (!allowed_paths) {
        return changes;
    }

    const filtered: Record<string, any> = {};
    for (const key of Object.keys(changes)) {
        if (is_path_affected(key, allowed_paths)) {
            filtered[key] = changes[key];
        }
    }
    return filtered;
}
