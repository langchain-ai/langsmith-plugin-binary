import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLAUDE_ALLOWED_TOOLS, CLAUDE_TYPING, EXIT_COMMAND, CLAUDE_MODEL } from "../constants.ts";
import type { PreparedAgent, RunOptions } from "../models.ts";
import { quoteForShell } from "../utils/shell.ts";
import { baseEnvironment, createWorkspace, recorderHooks } from "../workspace.ts";

export function prepareClaude(options: RunOptions): PreparedAgent {
  const workspace = createWorkspace(options.workDir, options.scenario);
  const configDir = join(options.workDir, "claude-config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, ".claude.json"),
    JSON.stringify({
      hasCompletedOnboarding: true,
      theme: "dark",
      projects: { [workspace.project]: { hasTrustDialogAccepted: true } },
    }),
  );
  const gatewayKeyFile = join(options.workDir, "gateway-key");
  writeFileSync(gatewayKeyFile, options.gatewayApiKey, { mode: 0o600 });
  const settings = {
    apiKeyHelper: `cat ${quoteForShell(gatewayKeyFile)}`,
    hooks: recorderHooks(workspace.eventsFile),
  };

  const sessionId = randomUUID();
  const baseArgs = [
    "--plugin-dir",
    options.pluginDir,
    "--settings",
    JSON.stringify(settings),
    "--model",
    CLAUDE_MODEL,
    "--allowedTools",
    CLAUDE_ALLOWED_TOOLS,
  ];

  return {
    eventsFile: workspace.eventsFile,
    headlessArgs: (prompt, turnIndex) => [
      ...baseArgs,
      "-p",
      prompt,
      turnIndex === 0 ? "--session-id" : "--resume",
      sessionId,
    ],
    secretFiles: [gatewayKeyFile],
    launch: {
      command: options.agentCommand,
      args: baseArgs,
      cwd: workspace.project,
      env: {
        ...baseEnvironment(workspace.home),
        CLAUDE_CONFIG_DIR: configDir,
        ANTHROPIC_BASE_URL: options.endpoints.anthropic,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        TRACE_TO_LANGSMITH: "true",
        LANGSMITH_ENDPOINT: options.endpoints.tracing,
        CC_LANGSMITH_ENDPOINT: options.endpoints.tracing,
        CC_LANGSMITH_API_KEY: options.tracingApiKey,
        CC_LANGSMITH_PROJECT: options.project,
      },
      typing: CLAUDE_TYPING,
      exitCommand: EXIT_COMMAND,
    },
  };
}
