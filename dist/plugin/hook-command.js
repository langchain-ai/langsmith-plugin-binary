import { describe } from "../utils/errors.js";
import { HOOK_ERROR_HANDLER_WARNING, HOOK_HELP_FLAGS, HOOK_OPTIONS_INVALID_MESSAGE, HOOK_VERSION_FLAGS, } from "./constants.js";
export async function dispatchHookCommand(argv, options) {
    assertHookOptions(options);
    const [argument, ...rest] = argv;
    if (argument !== undefined && HOOK_HELP_FLAGS.includes(argument)) {
        console.log(options.usage);
    }
    else if (argument !== undefined && HOOK_VERSION_FLAGS.includes(argument)) {
        console.log(options.version);
    }
    else if (argument !== undefined && options.worker?.command === argument) {
        await guarded(argument, () => options.worker.run(rest), options);
    }
    else if (argument !== undefined && Object.hasOwn(options.hooks, argument)) {
        await guarded(argument, options.hooks[argument], options);
    }
    else {
        options.onUnknown(argument);
    }
}
async function guarded(name, run, options) {
    try {
        await run();
    }
    catch (error) {
        reportHookError(name, error, options);
    }
}
function assertHookOptions(options) {
    if (options === null ||
        typeof options !== "object" ||
        options.hooks === null ||
        typeof options.hooks !== "object" ||
        typeof options.onHookError !== "function" ||
        typeof options.onUnknown !== "function")
        throw new TypeError(HOOK_OPTIONS_INVALID_MESSAGE);
}
function reportHookError(name, error, options) {
    try {
        options.onHookError(name, error);
    }
    catch (handlerError) {
        console.warn(HOOK_ERROR_HANDLER_WARNING, describe(handlerError));
    }
}
//# sourceMappingURL=hook-command.js.map