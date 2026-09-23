import { readFileSync } from "node:fs";
import { TEMPLATE_URL } from "./constants.js";
import { environmentVariableHelp, escapeForDoubleQuotedShell } from "./utils/shell.js";
function readInstallerTemplate() {
    return readFileSync(TEMPLATE_URL, "utf-8");
}
export function renderInstaller(config, template = readInstallerTemplate()) {
    const { installer } = config;
    const replacements = {
        "@EXECUTABLE@": config.executableName,
        "@REPOSITORY@": config.repository,
        "@ENVIRONMENT_PREFIX@": installer.environmentPrefix,
        "@PRODUCT_NAME@": installer.productName,
        "@SHORT_URL@": installer.shortUrl,
        "@ENVIRONMENT_VARIABLE_HELP@": environmentVariableHelp(installer.environmentPrefix),
        "@HELP_FOOTER@": installer.helpFooter.join("\n"),
        "@UNSUPPORTED_PLATFORM_HELP@": installer.unsupportedPlatformHelp
            .map(escapeForDoubleQuotedShell)
            .join("\n"),
    };
    let rendered = template;
    for (const [token, value] of Object.entries(replacements)) {
        rendered = rendered.split(token).join(value);
    }
    const leftover = /@[A-Z_]+@/.exec(rendered);
    if (leftover !== null) {
        throw new Error(`the installer template has an unfilled ${leftover[0]} placeholder`);
    }
    return rendered;
}
//# sourceMappingURL=install-script.js.map