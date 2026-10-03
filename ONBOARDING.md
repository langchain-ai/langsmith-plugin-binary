# Onboarding a plugin onto the shared pipeline

You make four edits in the plugin's repo. Releases land in that repo, not this one.

You add or change these:

- `binary.config.json`
- `package.json`, one dependency and two scripts
- one source file that names the binary
- `.github/workflows/build-binary.yml`

## Reference implementations

Copy from whichever plugin is closer to yours.

| Plugin      | Repo                                                                                           | Onboarded |
| ----------- | ---------------------------------------------------------------------------------------------- | --------- |
| Claude Code | [langsmith-claude-code-plugins](https://github.com/langchain-ai/langsmith-claude-code-plugins) | yes       |
| Codex       | [langsmith-codex-plugins](https://github.com/langchain-ai/langsmith-codex-plugins)             | in review |

Claude Code is the working example. Read its caller workflow and its binary config first.

## 1. binary.config.json

Put it at the repo root. It names the executable and the repo. It also says where the build and signing steps find their inputs. Every later step reads it.

Both reference configs sit in `test/fixtures/`. Start from one.

`build.versionFile` is the file the binary takes its version from.

Some plugins repeat that version elsewhere, such as in a manifest. List those files under `build.matchingVersionFiles`. A release then stops unless every one matches the tag.

Some plugins commit build output with the version baked in, such as a bundled hook script. List those under `build.stampedVersionFiles`. A release stops unless each one carries the tag. This catches a bundle nobody rebuilt, in the first minute rather than after signing.

## 2. Dependency and scripts

```
pnpm add -D github:langchain-ai/langsmith-plugin-binary#v0.3.0
```

This is not published to npm. It is a git dependency pinned to a tag.

Add these to `package.json`:

```json
"build:binary": "langsmith-plugin-binary build",
"sign:binary": "langsmith-plugin-binary sign"
```

Your plugin also needs its own `test:binary` script. The pipeline runs it on every machine that builds or signs.

## 3. Name the binary target

```ts
import { defineBinaryTarget } from "@langchain/langsmith-plugin-binary";
import config from "../binary.config.json" with { type: "json" };

export const binary = defineBinaryTarget({
  executableName: config.executableName,
  repository: config.repository,
  userAgent: "langsmith-claude-code",
});
```

Read the two names out of the settings file. Do not spread the whole file in.

This keeps the published name and the name the binary looks for in step. It also keeps your build and signing settings out of the bundle users download.

Check the bundle afterwards. Some bundlers keep every key of an imported JSON file, even when the code reads two. Strip the unused sections at build time if yours does.

| Call                                    | When                                               |
| --------------------------------------- | -------------------------------------------------- |
| `binary.supportsHost()`                 | Before telling a user the binary will not run here |
| `binary.assetName(platform, arch, tag)` | To name the published file for a chip              |

## 4. Caller workflow

Create `.github/workflows/build-binary.yml`:

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
      pull-requests: write
    uses: langchain-ai/langsmith-plugin-binary/.github/workflows/build-binary.yml@v0.3.0
    secrets: inherit
```

Each line matters:

- `contents: write`, or the release upload fails
- `pull-requests: write`, or the beta pull request never opens
- `secrets: inherit`, or signing stops the release
- Do not pass `beta-branch`. The pipeline works the branch out from the tag. A caller that still passes it must drop the line, since GitHub refuses a run with an input the workflow does not define
- Point `binary-directory` at the folder the plugin already runs its builds from
- Add no `paths:` filter. A filter that names files breaks silently on a rename
- Add no `concurrency:` block. A matching group name makes the run queue behind itself

The repo also needs the `macos-signing` environment and its Apple credentials. Terraform grants those, in `langchainplus`.

## Releasing

Three steps.

1. Open one pull request that bumps the version.
2. Tag the tip of that branch.
3. Run the workflow by hand against that tag. A tag push alone publishes nothing.

The pipeline builds and signs. It drafts the release in your plugin's repo. Then it commits the signed binaries onto your branch.

So your open pull request now carries the version and the binaries. One merge ships both.

The pipeline finds your branch by asking GitHub which branch ends at the tagged commit. The answer is the same however you made the tag.

Two cases stop the release rather than guessing. A tag that ends no branch stops it. A tag that two branches both end at stops it, unless one of them is the default branch.

Tagging the default branch still opens a separate pull request. You have no pull request of your own to add to.

Pass `release-notes:` to add a line to every release.

## Betas

Cut a `beta-<minor>` branch off the default branch. Bump the version on that branch only. Never merge it back, so the default branch keeps its own version.

The branch belongs to the plugin rather than to whoever cut it. So it carries no user prefix.

Tag off that branch as `<minor>-beta` or `<minor>-beta.N`. A dash in the tag means beta.

The tag says which branch gets the binaries. So `0.5.0-beta.1` goes to `beta-0.5.0`. You name nothing.

A release stops if that branch is missing. It also stops if the branch is short of work the default branch already has. Binaries built for a stale beta line have nowhere sensible to land. Merge the default branch in, then tag again.

A beta's binaries arrive as a pull request against the beta branch. Someone merges it.

People opt in by pointing the marketplace at the branch:

```
/plugin marketplace add langchain-ai/langsmith-claude-code-plugins@beta-0.5.0
```
