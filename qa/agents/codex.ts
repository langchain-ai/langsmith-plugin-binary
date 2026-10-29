import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CODEX_MODEL, CODEX_TYPING, EXIT_COMMAND, GATEWAY_KEY_ENV } from "../constants.ts";
import type { PreparedAgent, HooksFile, RunOptions } from "../models.ts";
import { quoteForShell } from "../utils/shell.ts";
import { baseEnvironment, createWorkspace, recorderHooks } from "../workspace.ts";

function codexConfig(projectDir: string, openaiUrl: string): string {
  return [
    `model = ${JSON.stringify(CODEX_MODEL)}`,
    `model_provider = "langsmith-gateway"`,
    "",
    "[model_providers.langsmith-gateway]",
    `name = "LangSmith Gateway"`,
    `base_url = ${JSON.stringify(openaiUrl)}`,
    `env_key = ${JSON.stringify(GATEWAY_KEY_ENV)}`,
    `wire_api = "responses"`,
    "supports_websockets = false",
    "",
    `[projects.${JSON.stringify(projectDir)}]`,
    `trust_level = "trusted"`,
    "",
    "[tui]",
    "screen_reader_detection_done = true",
    "",
  ].join("\n");
}

function writeTracingEnvironment(path: string, options: RunOptions): void {
  const settings = {
    TRACE_TO_LANGSMITH: "true",
    HOME: join(options.workDir, "plugin-home"),
    PLUGIN_ROOT: options.pluginDir,
    LANGSMITH_ENDPOINT: options.endpoints.tracing,
    LANGSMITH_CODEX_ENDPOINT: options.endpoints.tracing,
    LANGSMITH_CODEX_API_KEY: options.tracingApiKey,
    LANGSMITH_CODEX_PROJECT: options.project,
  };
  const lines = Object.entries(settings).map(
    ([name, value]) => `export ${name}=${quoteForShell(value)}`,
  );
  writeFileSync(path, `${lines.join("\n")}\n`, { mode: 0o600 });
}

function pluginHooksWithSettings(pluginDir: string, environmentFile: string): HooksFile {
  const plugin = JSON.parse(
    readFileSync(join(pluginDir, "hooks", "hooks.json"), "utf8"),
  ) as HooksFile;
  const prefix = `. ${quoteForShell(environmentFile)} && `;
  const hooks = Object.fromEntries(
    Object.entries(plugin.hooks).map(([event, groups]) => [
      event,
      groups.map((group) => ({
        ...group,
        hooks: group.hooks.map((hook) => ({ ...hook, command: prefix + hook.command })),
      })),
    ]),
  );
  return { hooks };
}

function mergedHooks(pluginHooks: HooksFile, eventsFile: string): HooksFile {
  const merged: HooksFile = { hooks: { ...pluginHooks.hooks } };
  for (const [event, groups] of Object.entries(recorderHooks(eventsFile))) {
    merged.hooks[event] = [...(merged.hooks[event] ?? []), ...groups];
  }
  return merged;
}

export function prepareCodex(options: RunOptions): PreparedAgent {
  const workspace = createWorkspace(options.workDir, options.scenario);
  const codexHome = join(options.workDir, "codex-home");
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(
    join(codexHome, "config.toml"),
    codexConfig(workspace.project, options.endpoints.openai),
  );
  const environmentFile = join(options.workDir, "tracing.env");
  writeTracingEnvironment(environmentFile, options);
  const pluginHooks = pluginHooksWithSettings(options.pluginDir, environmentFile);
  mkdirSync(join(workspace.project, ".codex"), { recursive: true });
  writeFileSync(
    join(workspace.project, ".codex", "hooks.json"),
    JSON.stringify(mergedHooks(pluginHooks, workspace.eventsFile), null, 2),
  );

  const baseArgs = [
    "--dangerously-bypass-hook-trust",
    "--sandbox",
    "workspace-write",
    "--ask-for-approval",
    "never",
  ];

  return {
    eventsFile: workspace.eventsFile,
    headlessArgs: (prompt, turnIndex) => [
      ...baseArgs,
      "exec",
      ...(turnIndex === 0 ? [] : ["resume", "--last"]),
      "--skip-git-repo-check",
      prompt,
    ],
    secretFiles: [environmentFile],
    launch: {
      command: options.agentCommand,
      args: baseArgs,
      cwd: workspace.project,
      env: {
        ...baseEnvironment(workspace.home),
        CODEX_HOME: codexHome,
        [GATEWAY_KEY_ENV]: options.gatewayApiKey,
      },
      typing: CODEX_TYPING,
      exitCommand: EXIT_COMMAND,
    },
  };
}
