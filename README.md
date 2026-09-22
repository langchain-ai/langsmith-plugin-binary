# langsmith-plugin-binary

Shared build, sign, install and update pipeline for the LangSmith plugin binaries.

The LangSmith plugins for Claude Code and OpenAI Codex each ship a standalone macOS
binary. Everything about getting that binary built, signed, downloaded and kept up to
date lives here, so both plugins behave the same way.

Releases still land in each plugin's own repository. This one publishes none.

## What is here

| Piece     | What it does                                                                      |
| --------- | --------------------------------------------------------------------------------- |
| Installer | The script users pipe to `bash`, and the generator that writes each plugin's copy |
| Updater   | Finds, downloads, verifies and installs a newer release                           |
| Build     | Compiles a plugin into a single macOS executable                                  |
| Sign      | Signs and notarizes that executable with Apple                                    |
| Workflow  | The GitHub Actions pipeline each plugin calls                                     |

## Using it

See [MIGRATION.md](MIGRATION.md).
