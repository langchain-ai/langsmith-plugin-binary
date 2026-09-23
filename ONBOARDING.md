# Onboarding a plugin onto the shared pipeline

Five edits in the plugin's repo. Releases land in that repo, not this one.

What you end up adding or changing:

- `binary.config.json`
- `package.json`, one dependency and six scripts
- one source file that calls `defineBinaryTarget`
- `install.sh`, generated not hand written
- `.github/workflows/build-binary.yml`

## Reference implementations

Copy from whichever is closer to your plugin.

| Plugin      | Repo                                                                                           | Onboarding PR |
| ----------- | ---------------------------------------------------------------------------------------------- | ------------- |
| Claude Code | [langsmith-claude-code-plugins](https://github.com/langchain-ai/langsmith-claude-code-plugins) | not yet       |
| Codex       | [langsmith-codex-plugins](https://github.com/langchain-ai/langsmith-codex-plugins)             | not yet       |

Neither is onboarded yet. Each PR link gets filled in when that plugin lands, tracked in
[issue #9](https://github.com/langchain-ai/langsmith-plugin-binary/issues/9). That diff
is the clearest example of what a plugin has to add.

## 1. binary.config.json

At the repo root. It names the executable, the repo, and where the build and signing
steps find their inputs. Every later step reads from it.

Both reference configs are in `test/fixtures/`. Start from one.

`helpFooter` and `unsupportedPlatformHelp` are the wording users see in the install
script. Keep the line `Only macOS arm64 and x64 are published` or the install tests fail.

## 2. Dependency and scripts

```
pnpm add -D github:langchain-ai/langsmith-plugin-binary#v0.1.0
```

Not published to npm. Git dependency pinned to a tag.

Add to `package.json`:

```json
"build:binary": "langsmith-plugin-binary build",
"sign:binary": "langsmith-plugin-binary sign",
"installer": "langsmith-plugin-binary installer",
"lint:installer": "langsmith-plugin-binary installer --check",
"test:install": "bash node_modules/@langchain/langsmith-plugin-binary/test/install/cases.sh",
"test:install:mutations": "bash node_modules/@langchain/langsmith-plugin-binary/test/install/variants.sh"
```

The plugin also needs its own `test:binary` script. The pipeline runs it on every machine
it builds or signs on.

## 3. Wire up the updater

```ts
import { defineBinaryTarget } from "@langchain/langsmith-plugin-binary";
import config from "../binary.config.json" with { type: "json" };

export const binary = defineBinaryTarget({
  executableName: config.executableName,
  repository: config.repository,
  userAgent: "langsmith-claude-code",
  releasesApiOverrideEnvVar: "CC_LANGSMITH_RELEASES_API",
});
```

Read the two names out of the settings file rather than spreading the whole thing in. That
keeps the name the installer downloads and the name the binary looks for in sync, without
shipping your build and signing settings to every user in the plugin bundle.

Check the bundle afterwards. Some bundlers keep every key of an imported JSON file even
when only two are read, in which case strip the unused sections at build time.

| Call                                         | When                                               |
| -------------------------------------------- | -------------------------------------------------- |
| `binary.update({ currentVersion })`          | `--update` and the background check                |
| `binary.install({ tag })`                    | `--install` with or without a named release        |
| `binary.installLocalCopy(path, version)`     | `--install` from a binary the user downloaded      |
| `binary.isInstalledBinary(process.execPath)` | Before the background check, to skip a stray copy  |
| `binary.supportsHost()`                      | Before telling a user the binary will not run here |

`isInstalledBinary` is a separate call rather than part of `update`, because `--update`
has to keep working from any directory.

## 4. install.sh

```
pnpm installer
```

Commit the result. Add `pnpm lint:installer` to the lint job so the committed file cannot
drift from the settings.

## 5. Caller workflow

`.github/workflows/build-binary.yml`:

```yaml
name: Build Binary

on:
  workflow_dispatch:
  push:
    branches: [main]
  pull_request:

jobs:
  binary:
    permissions:
      contents: write
    uses: langchain-ai/langsmith-plugin-binary/.github/workflows/build-binary.yml@v0.1.0
    secrets: inherit
```

- `contents: write` is required or the release upload fails
- `secrets: inherit` is required or signing stops the release
- No `paths:` filter. One that names files breaks silently on a rename
- No `concurrency:` block. A matching group name makes the run queue behind itself

The repo needs the `macos-signing` environment and its Apple credentials. Those are
granted in Terraform, in `langchainplus`.

## Releasing

Tag the version, then run the workflow by hand against that tag. A tag push alone
publishes nothing. The draft release lands in the plugin's repo.

Pass `release-notes:` to add a line to every release.
