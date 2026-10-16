/**
 * Setup for the reconcile tests: runs shaped the way a turn record holds them.
 */

import type { RecordedRun, TurnRecord } from "../tracing/settlement/models.js";

export const inAlpha = {
  ls_git_repo: "acme/a",
  ls_repo_provider: "github",
  ls_git_repo_url: "https://github.com/acme/a",
  ls_git_branch: "trunk-a",
  ls_git_commit_hash: "aaaa",
  ls_attribution_identifier: "Alpha Owner",
};

export const inBeta = {
  ls_git_repo: "acme/b",
  ls_repo_provider: "gitlab",
  ls_git_repo_url: "https://gitlab.com/acme/b",
  ls_git_branch: "trunk-b",
  ls_git_commit_hash: "bbbb",
  ls_attribution_identifier: "Beta Owner",
};

/** A run as the record holds it, with its place in the turn given by `order`. */
export function recorded(name: string, metadata: Record<string, unknown>, order = 1): RecordedRun {
  return {
    run_id: name,
    parent_run_id: "root",
    trace_id: "trace",
    dotted_order: `trace.2025010100000${order}000000Z${name}`,
    name,
    run_type: "tool",
    project_name: "p",
    // Recent, since the settle gives up on a turn the service would no longer accept.
    start_time: new Date().toISOString(),
    end_time: new Date().toISOString(),
    tracing: "full",
    metadata,
  };
}

export function record(
  root: Record<string, unknown>,
  children: RecordedRun[],
  overrides: Partial<TurnRecord> = {},
): TurnRecord {
  return {
    path: "/tmp/turn.jsonl",
    origin: "account",
    root: {
      ...recorded("root", root),
      run_id: "root",
      parent_run_id: undefined,
      run_type: "chain",
    },
    children,
    closed: true,
    delivered: new Set(children.map((child) => child.run_id)),
    fixed: new Set(),
    ...overrides,
  };
}
