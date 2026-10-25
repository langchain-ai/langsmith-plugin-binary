# Plugin Settings

The LangSmith plugins for Claude Code, Cursor and Codex take each setting from the first place below that sets it, and an admin can lock settings with a managed file at the top.

1. The managed file at `~/.langsmith-plugins/managed.json`
2. Environment variables, such as `LANGSMITH_ENDPOINT`
3. `<project>/<agent folder>/langsmith.json`, where the agent folder is `.claude`, `.cursor` or `.codex`
4. `<project>/langsmith-plugins.json`, shared by every plugin
5. `~/<agent folder>/langsmith.json`
6. `~/.langsmith-plugins.json`, shared by every plugin
7. The plugin's defaults

Each setting comes from the highest place in this list that sets it. A settings file that's broken or unreadable is skipped for every setting except tracing on and muted by default, which it counts as off and muted at its place, so a broken file above the one that turns tracing on stops tracing. A managed file that's present but broken or untrusted stops tracing whatever else is set.

## Locking settings with the managed file

- Each user account gets its own managed file in that user's home folder, at `~/.langsmith-plugins/managed.json`
- Every setting in a valid managed file wins and the plugin logs one line naming what it ignored, though metadata (extra labels on traces) is locked one key at a time
- Locking `api_key` or `replicas` also locks `api_url` to the file's value or the default server
- Locking `api_url` (where traces go) or `project` also locks `replicas` (extra copies) to the file's list or none, and locking `redact_extra_rules` keeps redaction on
- Locking `project` also applies to traces still waiting to upload, and a plugin's own settings (such as Cursor's `attachments`) lock when that plugin supports it, with a warning for ones it can't
- It's valid only when the folder and file are owned by root, nobody else can write to them and neither is a symlink (a shortcut to another file)
- The managed file is only supported on macOS and Linux
- A missing file changes nothing, while a file that fails these checks stops tracing for the session and tells the user to contact an admin

## Setting it up on macOS

Save the settings to lock as `managed.json`:

```json
{
  "api_url": "https://langsmith.example.com",
  "project": "engineering",
  "redact_extra_rules": [{ "pattern": "ACME-SECRET-[0-9]+", "replace": "[redacted]" }]
}
```

Then have your MDM (the tool that manages company laptops) run this for each user. It runs as root, so `~` would mean root's own home, which is why the block sets the user's home explicitly:

```sh
USER_HOME=/Users/alice   # the user's home folder, their ~
mkdir -p "$USER_HOME/.langsmith-plugins"
cp managed.json "$USER_HOME/.langsmith-plugins/managed.json"
chown root:wheel "$USER_HOME/.langsmith-plugins" "$USER_HOME/.langsmith-plugins/managed.json"
chmod 755 "$USER_HOME/.langsmith-plugins"
chmod 644 "$USER_HOME/.langsmith-plugins/managed.json"
chflags schg "$USER_HOME/.langsmith-plugins"   # optional: stops the user renaming the folder, clear with chflags noschg before updating
```

On Linux use `root:root` and `chattr +i` instead of `chflags schg`.
