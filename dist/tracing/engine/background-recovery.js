import { describe } from "../../utils/errors.js";
import { TRACING_ENGINE_FOREIGN_SESSION_MIN_AGE_MS } from "./constants.js";
import { recoverTracingSessions } from "./recovery.js";
function retryableFailure(error) {
    return { status: "failed", message: describe(error), retryable: true };
}
function worse(previous, next) {
    if (previous.kind === "failed")
        return previous;
    if (next.kind === "ok")
        return previous;
    return next.kind === "failed" || previous.kind === "ok" ? next : previous;
}
function verdictResult(verdict) {
    if (verdict.kind === "failed")
        return retryableFailure(verdict.error);
    return verdict.kind === "mismatch" ? { status: "scope-mismatch" } : undefined;
}
export async function runBackgroundRecovery(runtime, options, scopeGuard) {
    let verdict = { kind: "ok" };
    const checkScope = scopeGuard
        ? async () => {
            try {
                const matches = await scopeGuard();
                verdict = worse(verdict, matches ? { kind: "ok" } : { kind: "mismatch" });
                return matches;
            }
            catch (error) {
                verdict = worse(verdict, { kind: "failed", error });
                return false;
            }
        }
        : undefined;
    try {
        if (checkScope && !(await checkScope()))
            return verdictResult(verdict);
        const report = await recoverTracingSessions(runtime, {
            optionsForSession: options.optionsForSession,
            minimumForeignAgeMs: options.minimumForeignAgeMs ?? TRACING_ENGINE_FOREIGN_SESSION_MIN_AGE_MS,
            now: Date.now(),
            excludeCurrentSession: true,
        }, checkScope);
        if (checkScope && verdict.kind === "ok")
            await checkScope();
        const stopped = verdictResult(verdict);
        if (stopped !== undefined)
            return stopped;
        return report.failed.length === 0
            ? { status: "completed", report }
            : { status: "partial", report, retryable: true };
    }
    catch (error) {
        return retryableFailure(error);
    }
}
//# sourceMappingURL=background-recovery.js.map