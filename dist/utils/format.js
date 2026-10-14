import { TEMPLATE_PLACEHOLDER } from "./constants.js";
export function fillTemplate(template, values) {
    return template.replace(TEMPLATE_PLACEHOLDER, (_match, key) => String(values[key]));
}
//# sourceMappingURL=format.js.map