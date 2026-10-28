# Plugin Settings

The LangSmith plugins for Claude Code, Cursor and Codex take each setting from the first place below that sets it. An admin can enforce settings with the managed file at the top of the list.

1. The managed file at `~/.langsmith-plugins/managed.json`
2. Environment variables, such as `LANGSMITH_ENDPOINT`
3. `<project>/<agent folder>/langsmith.json`, where the agent folder is `.claude`, `.cursor` or `.codex`
4. `<project>/langsmith-plugins.json`, shared by every plugin
5. `~/<agent folder>/langsmith.json`
6. `~/.langsmith-plugins.json`, shared by every plugin
7. The plugin's defaults

A managed file that's present but broken or untrusted stops tracing no matter what else is set.

## Notices

When tracing pauses the plugin tells the user why, for example an expired login, a rejected API key or a broken managed file. Claude Code and Codex show this notice in the chat and Cursor writes it to its log.

Each notice repeats at most once every `notice_cooldown` minutes across conversations so it doesn't nag. The default is 2 and `off` silences notices.

Strict auth refuses every prompt while the LangSmith login is expired or the API key is rejected, and keeps refusing until the user signs in again or fixes the key. Turn it on with `strict_auth` since it's off by default.

## Enforce settings with the managed file

Each user account gets its own managed file in its home folder at `~/.langsmith-plugins/managed.json`. It only works on macOS and Linux.

The plugin only trusts the file when:

- Root owns the file and its folder
- No one else can write to either
- Neither is a symlink (a shortcut to another file)

A missing file changes nothing. A file that fails these checks stops tracing for the session and tells the user to contact an admin.

Every setting in a valid managed file overrides the user's own value and the plugin logs one line naming what it overrode. Metadata (extra labels on traces) works key by key, so the file controls only the keys it names and users can still add others.

Setting some fields in the managed file also fixes related fields so users can't send traces around it:

- Setting `api_key` or `replicas` also fixes `api_url` to the file's value or the default server
- Setting `api_url` (where traces go) or `project` also fixes `replicas` (extra copies) to the file's list or none
- Setting `redact_extra_rules` keeps redaction on
- Setting `project` also applies to traces still waiting to upload
- Setting `project` without `agent_id` makes the plugin ignore any `agent_id` a user sets, so traces still go to that project

A plugin's own settings, such as Cursor's `attachments`, can go in the managed file when that plugin supports it. Otherwise the plugin logs a warning and ignores them.

## Set it up on macOS

Save the settings to enforce as `managed.json`:

```json
{
  "api_url": "https://langsmith.example.com",
  "project": "engineering",
  "redact_extra_rules": [{ "pattern": "ACME-SECRET-[0-9]+", "replace": "[redacted]" }]
}
```

Then have your MDM (the tool that manages company laptops) run this for each user. It runs as root so `~` would mean root's own home, which is why the block sets the user's home explicitly:

```sh
USER_HOME=/Users/alice   # the user's home folder, their ~
mkdir -p "$USER_HOME/.langsmith-plugins"
cp managed.json "$USER_HOME/.langsmith-plugins/managed.json"
chown root:wheel "$USER_HOME/.langsmith-plugins" "$USER_HOME/.langsmith-plugins/managed.json"
chmod 755 "$USER_HOME/.langsmith-plugins"
chmod 644 "$USER_HOME/.langsmith-plugins/managed.json"
chflags schg "$USER_HOME/.langsmith-plugins"   # recommended: stops the user renaming the folder to get around it, clear with chflags noschg before updating
```

On Linux use `root:root` and `chattr +i` instead of `chflags schg`.

## Choose where traces go

Set `agent_id` to send traces to an agent or `project` to send them to a project. Either one works on its own, and `agent_id` wins if you set both.

An agent ID uses lowercase letters, numbers and hyphens and starts with a letter. If `agent_id` doesn't match that the plugin stops uploading and shows a notice saying why, but your prompts still go through. A replica that doesn't name its own project goes to the same agent as long as it uses the same login, server and workspace.

## Sign in with the LangSmith CLI

The plugins upload with the login from `langsmith auth login` unless the plugin's own API key is set. A generic `LANGSMITH_API_KEY` is only used when there's no usable login.

The login's own server and workspace are used unless a setting names an endpoint, and a login for a different server than that endpoint isn't used.

`workspace_id` picks the workspace traces go to when you sign in with the CLI. Your login needs access to that workspace, otherwise uploads fail and the plugin shows a notice without blocking prompts unless strict auth is on. API keys already belong to one workspace so they ignore this setting.

If you have more than one CLI profile, set `profile` to the one the plugin should use. You sign in to a profile with `langsmith auth login --profile <name>`.

When the login expires, uploads are dropped just like with a rejected API key until you sign in again. A rejected API key gets a notice to replace it until an upload with a key works again.

The plugins never open a browser, so the user runs `langsmith auth login` themselves.
