import { ENVIRONMENT_VARIABLE_DESCRIPTIONS } from "../constants.js";

export function environmentVariableHelp(environmentPrefix: string): string {
  const names = ENVIRONMENT_VARIABLE_DESCRIPTIONS.map(
    ([suffix]) => `${environmentPrefix}_${suffix}`,
  );
  const column = Math.max(...names.map((name) => name.length)) + 3;
  return ENVIRONMENT_VARIABLE_DESCRIPTIONS.map(
    ([, description], index) => `  ${names[index]!.padEnd(column)}${description}`,
  ).join("\n");
}

export function escapeForDoubleQuotedShell(line: string): string {
  return line.replace(/[\\"$`]/g, (character) => `\\${character}`);
}
