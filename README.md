# @langchain/plugins-base

The shared engine behind the LangSmith tracing plugins for Claude Code, Cursor and Codex. It turns each agent's hook events into LangSmith traces and builds each plugin's signed macOS binary.

```sh
pnpm add @langchain/plugins-base
```

## How it works

Each plugin ships the engine inside itself rather than calling a separate service. A hook saves the event to disk and returns right away, then a background worker uploads it so the agent never waits on LangSmith.

```mermaid
flowchart TB
  agent(["Claude Code, Cursor or Codex"])

  subgraph machine["On the user's machine"]
    direction TB
    plugin["Plugin hook"]
    disk[("Events on disk")]
    worker["Background worker"]
    cleanup["Delete the uploaded events"]
  end

  langsmith(["LangSmith"])

  agent -->|hook fires| plugin
  plugin -->|saves the event and returns| disk
  disk --> worker
  worker -->|uploads with retries| langsmith
  worker -.->|after the upload succeeds| cleanup

  classDef trigger fill:#F6FFDB,stroke:#6E8900,stroke-width:2px,color:#2E3900
  classDef process fill:#E5F4FF,stroke:#006DDD,stroke-width:2px,color:#030710
  classDef storage fill:#F2FAFF,stroke:#40668D,stroke-width:2px,color:#2F4B68
  classDef output fill:#EBD0F0,stroke:#885270,stroke-width:2px,color:#441E33
  classDef cleanup fill:#F8E8E6,stroke:#B27D75,stroke-width:2px,color:#634643
  class agent trigger
  class plugin,worker process
  class disk storage
  class langsmith output
  class cleanup cleanup
  style machine fill:none,stroke:#40668D,stroke-dasharray:4 4
```

- **Plugin** reads its agent's events and transcript, and imports everything else from the engine.
- **Settings** ([src/settings](src/settings)) merges config files, environment variables and an admin's managed file. See the [settings guide](docs/settings.md).
- **Events on disk** ([src/storage](src/storage)) act as the queue, so nothing is lost if the agent exits mid-turn. A turn's files are deleted once it uploads.
- **Background worker** ([src/tracing](src/tracing)) rebuilds the runs, adds git metadata, strips secrets and uploads with retries.
- **Auth** ([src/auth](src/auth)) uses the plugin's own key first, then the `langsmith auth login` sign-in, then a key from the shell.

## Building the plugin binaries

Each plugin calls this repo's reusable `build-binary.yml` workflow pinned to a release tag's commit.

```mermaid
flowchart TB
  tag(["Plugin release tag"])
  build["Build Apple chip and Intel binaries with Bun"]
  test["Run the plugin's binary tests"]
  sign["Sign and have Apple notarize them"]
  release(["Attach to the plugin's release and commit into the plugin"])

  tag --> build --> test --> sign --> release

  classDef trigger fill:#F6FFDB,stroke:#6E8900,stroke-width:2px,color:#2E3900
  classDef process fill:#E5F4FF,stroke:#006DDD,stroke-width:2px,color:#030710
  classDef output fill:#EBD0F0,stroke:#885270,stroke-width:2px,color:#441E33
  class tag trigger
  class build,test,sign process
  class release output
```

See [ONBOARDING.md](docs/ONBOARDING.md) to set up a new plugin.

## Developing

```sh
pnpm install
pnpm test
pnpm run lint
pnpm run build   # also runs on install, since dist/ is built rather than committed
```
