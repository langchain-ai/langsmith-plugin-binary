import { TEMPLATE_PLACEHOLDER } from "./constants.js";

export function fillTemplate(template: string, values: Record<string, string | number>): string {
  return template.replace(TEMPLATE_PLACEHOLDER, (_match, key: string) => String(values[key]));
}
