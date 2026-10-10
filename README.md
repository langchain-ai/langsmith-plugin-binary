# @langchain/plugins-base

Shared tracing runtime and binary build pipeline for LangChain plugins.

Runtime modules support Node 20. The CLI, build, lint and test tooling uses Node 22 or newer.

Plugin binary releases land in each plugin's own repo. Shared settings are available from `@langchain/plugins-base/settings`:

```ts
import { parseCommonConfig } from "@langchain/plugins-base/settings";
```

## Shared tracing runtime

The runtime saves trace work before a background process uploads it. Claude Code, Cursor and Codex adapters interpret their own hooks and transcripts, then use the same storage, metadata, privacy and delivery rules.

Import `createTracingEngine` from `@langchain/plugins-base/tracing` and configure a private storage root, integration name and writer. Each session supplies native reconstruction, worker launch and current-account callbacks.

- Save a trace operation and its dependencies with `capture`
- Save source snapshots with their reconstruction job through `queueReconstruction`
- Process saved work and record delivery receipts with `drain`
- Schedule unfinished work after a restart with `recoverSessions`

Keep event IDs stable across retries and link updates to their saved create operation. A `CaptureWakeError` means the work was saved but worker startup failed, so recover that work instead of sending it through another uploader.

Configure one primary destination and optional replicas on the writer. Configured replicas replace the implicit primary route, with stable destination-specific run IDs and separate delivery receipts. Metadata-only traces discard private content and replica updates.

The shared metadata contract lives in `@langchain/plugins-base/metadata`. Native adapters supply hook-specific values while this package owns the common field names, identity rules and privacy projection. Runtime consumers supply a compatible `langsmith` peer dependency (`^0.9.0` or `^0.10.0`).

## Plugin adapters

| Plugin      | Repo                            | Status                        |
| ----------- | ------------------------------- | ----------------------------- |
| Claude Code | `langsmith-claude-code-plugins` | Runtime migration in progress |
| Codex       | `langsmith-codex-plugins`       | Runtime migration in progress |
| Cursor      | `langsmith-cursor-plugins`      | Runtime migration in progress |

## What happens on a release

1. Compile the plugin into two macOS binaries. One per chip
2. Run the Intel one on a real Intel machine
3. Sign both and wait for Apple to notarize them
4. Attach both to a draft release with a checksum beside each
5. Commit both binaries onto the branch the tag was cut from, so one merge ships the version
   and the builds together

Three things stop a release instead of shipping something broken. A binary built for the
wrong chip. A binary reporting the wrong version. A missing Apple credential.

Every step gets the file name from the same settings file. Nothing drifts apart.

## Where the code is

|                                      |                             |
| ------------------------------------ | --------------------------- |
| `src/build.ts`                       | compiles                    |
| `src/sign.ts`                        | signs and notarizes         |
| `.github/workflows/build-binary.yml` | the pipeline a plugin calls |

## Onboarding a plugin

See [ONBOARDING.md](ONBOARDING.md).
