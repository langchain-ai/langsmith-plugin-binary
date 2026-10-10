# @langchain/plugins-base

Shared build and signing pipeline for LangChain plugin binaries.

Runtime modules support Node 20. The CLI, build, lint and test tooling uses Node 22 or newer.

Plugin binary releases land in each plugin's own repo. Shared settings are available from `@langchain/plugins-base/settings`:

```ts
import { parseCommonConfig } from "@langchain/plugins-base/settings";
```

## Onboarded plugins

| Plugin      | Repo                            | Status      |
| ----------- | ------------------------------- | ----------- |
| Claude Code | `langsmith-claude-code-plugins` | not started |
| Codex       | `langsmith-codex-plugins`       | not started |

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
