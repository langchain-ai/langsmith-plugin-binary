# langsmith-plugin-binary

Shared build, sign, install and update pipeline for the LangSmith plugin binaries.

Releases land in each plugin's own repo. This one publishes nothing.

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
5. On a beta, open a pull request putting both binaries on the plugin's beta branch
6. A user runs the install script. It finds that release and checks the checksum
7. Later the installed binary spots a newer release and replaces itself

Three things stop a release instead of shipping something broken. A binary built for the
wrong chip. A binary reporting the wrong version. A missing Apple credential.

Every step gets the file name from the same settings file. Nothing drifts apart.

## Where the code is

|                                      |                              |
| ------------------------------------ | ---------------------------- |
| `src/build.ts`                       | compiles                     |
| `src/sign.ts`                        | signs and notarizes          |
| `src/install-script.ts`              | generates the install script |
| `src/update.ts`                      | self-update                  |
| `.github/workflows/build-binary.yml` | the pipeline a plugin calls  |

## Onboarding a plugin

See [ONBOARDING.md](ONBOARDING.md).
