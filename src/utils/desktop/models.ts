export interface DesktopCommand {
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
}

export type DesktopLauncher = (
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  output?: number,
) => number | undefined;
