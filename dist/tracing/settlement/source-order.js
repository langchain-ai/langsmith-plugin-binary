export function uniqueScopes(scopes) {
    const unique = new Map();
    for (const scope of scopes)
        unique.set(JSON.stringify(scope), scope);
    return [...unique.values()].toSorted(compareScopes);
}
export function captureScope(record) {
    return {
        integration: record.integration,
        sessionId: record.sessionId,
        turnId: record.turnId,
        eventId: record.eventId,
    };
}
export function captureScopeKey(scope) {
    return JSON.stringify([scope.integration, scope.sessionId, scope.turnId, scope.eventId]);
}
function captureKey(record) {
    return captureScopeKey(captureScope(record));
}
export function compareScopes(left, right) {
    return JSON.stringify(left).localeCompare(JSON.stringify(right));
}
function compareCaptures(left, right) {
    if (left.capturedAtMs !== right.capturedAtMs)
        return left.capturedAtMs - right.capturedAtMs;
    return left.eventId.localeCompare(right.eventId);
}
export function orderSourceCaptures(records) {
    const byScope = new Map(records.map((record) => [captureKey(record), record]));
    const dependents = new Map(records.map((record) => [captureKey(record), []]));
    const dependencyCounts = new Map(records.map((record) => [captureKey(record), 0]));
    for (const record of records) {
        const recordKey = captureKey(record);
        for (const dependency of record.dependencies ?? []) {
            const prerequisiteKey = captureScopeKey(dependency);
            const prerequisite = byScope.get(prerequisiteKey);
            if (prerequisite === undefined)
                continue;
            dependents.get(prerequisiteKey).push(record);
            dependencyCounts.set(recordKey, dependencyCounts.get(recordKey) + 1);
        }
    }
    const ready = [];
    for (const record of records) {
        if (dependencyCounts.get(captureKey(record)) === 0)
            pushOrderedCapture(ready, record);
    }
    const ordered = [];
    while (ready.length > 0) {
        const record = popOrderedCapture(ready);
        ordered.push(record);
        for (const dependent of dependents.get(captureKey(record)) ?? []) {
            const key = captureKey(dependent);
            const count = dependencyCounts.get(key) - 1;
            dependencyCounts.set(key, count);
            if (count === 0)
                pushOrderedCapture(ready, dependent);
        }
    }
    if (ordered.length !== records.length)
        throw new TypeError("Source capture dependencies contain a cycle");
    return ordered;
}
function compareSourceCaptures(left, right) {
    return compareCaptures(left, right) || compareScopes(captureScope(left), captureScope(right));
}
function pushOrderedCapture(heap, record) {
    let index = heap.length;
    heap.push(record);
    while (index > 0) {
        const parentIndex = Math.floor((index - 1) / 2);
        const parent = heap[parentIndex];
        if (compareSourceCaptures(parent, record) <= 0)
            break;
        heap[index] = parent;
        index = parentIndex;
    }
    heap[index] = record;
}
function popOrderedCapture(heap) {
    const first = heap[0];
    if (first === undefined)
        return undefined;
    const last = heap.pop();
    if (heap.length === 0)
        return first;
    let index = 0;
    while (index * 2 + 1 < heap.length) {
        const leftIndex = index * 2 + 1;
        const rightIndex = leftIndex + 1;
        const childIndex = rightIndex < heap.length && compareSourceCaptures(heap[rightIndex], heap[leftIndex]) < 0
            ? rightIndex
            : leftIndex;
        const child = heap[childIndex];
        if (compareSourceCaptures(last, child) <= 0)
            break;
        heap[index] = child;
        index = childIndex;
    }
    heap[index] = last;
    return first;
}
export function groupByTurn(records) {
    const turns = new Map();
    for (const record of records) {
        const captures = turns.get(record.turnId) ?? [];
        captures.push(record);
        turns.set(record.turnId, captures);
    }
    return turns;
}
export function report(turnId, status, reason, runIds = [], destinations = []) {
    return {
        turnId,
        status,
        reason,
        ...(runIds.length === 0 ? {} : { runIds }),
        ...(destinations.length === 0 ? {} : { destinations }),
        patches: 0,
    };
}
//# sourceMappingURL=source-order.js.map