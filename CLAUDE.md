# CLAUDE.md

This file guides Claude Code (claude.ai/code) and other contributors working in this repository.

## What this is

`@swttch/session-manager-mcp`: an MCP server that lets a Claude Code session manage Claude Code sessions (list, search, message, stop, group, archive, start, worktrees, pull requests). It is a standalone product that ships on its own (npm), inside the Swttch JetBrains plugin and inside Swttch Desktop. It must work without either of them.

## Language

**Everything tracked by git is written in English**: code, comments, tests, commit messages, README, this file, issues and pull requests. Notes in Korean belong in `CLAUDE.local.md` and `ignore/`, both of which git ignores.

## Principles

1. **No runtime dependencies.** The package is plain ES modules and Node built-ins. MCP is an open protocol, so the JSON-RPC handler (`src/mcp-handler.js`) and the stdio transport (`src/stdio.js`) are small and local. Do not add an SDK or any other dependency without a strong reason.
2. **Documented commands only.** Talk to the Claude CLI through what a terminal user can run: `claude agents --json`, `claude --resume <id> -p`, `claude --session-id`, `claude mcp list`, and commands typed at it such as `/rename`. What the CLI has a place for (a session's name) is kept in that place, through the CLI; only what it has no place for (archive, groups, who started whom) lives in the marks. Do not depend on undocumented flags, internal protocols or another program's private files. Reading the transcripts the CLI writes to `<config dir>/projects/*/*.jsonl` is allowed; modifying them is not (deleting a session is the one explicit exception and says so). The one other file this package reads is the Claude desktop app's session folder (`src/desktop-sessions.js`), read-only and tolerant: a file that does not look as expected is skipped, and the programs that show sessions get its answers only through this package's commands, never by opening the folder themselves.
3. **Never pretend.** A tool that cannot do something answers `unavailable: <reason>` (an error result), and names what is missing. A tool that queues work for someone else says `queued` and does not claim a result.
4. **Layers.** Read tools need only the transcripts. Control tools need the CLI or the program running the session (found through the CLI registry, `src/owner-control.js`). Screen tools need a desktop (they append to `ui/ui_commands`). Keep each tool in the lowest layer that can do its job.
5. **State is append-only text.** `src/store/jsonl-table.js` writes one JSON line per change to `<CCG_HOME>/entities/<domain>/<table>.entity.jsonl`; the later line for an id wins; `{"id":..,"deleted":true}` removes a row; a broken line is skipped and kept. Several programs share these files, so never rewrite or compact a file here.
6. **Rows are classes.** Entities in `src/store/entities.js` are classes with `fromRow`/`toRow`. A plain object exists only at the file boundary.
7. **Be conservative with destructive tools.** Refuse the calling session, skip sessions another program runs, keep work that would be lost unless explicitly forced, and keep every path inside the session's folder.

## Layout

```
src/
├── cli.js              entry point: --area <name> serves one area over stdio
├── areas.js            area name -> tool factory; server name is swttch_<area>
├── mcp-handler.js      initialize, tools/list, tools/call (pure, no I/O)
├── stdio.js            newline-delimited JSON-RPC transport
├── cli-sessions.js     read-only access to the CLI's transcripts
├── cli-runtime.js      the only place that runs claude/git/gh: exec, spawn, which (Windows-aware)
├── owner-control.js    find and call the program that runs a session
├── worktrees.js        git worktree create/remove/restore
├── launch.js           start a fresh session
├── proposals.js        suggested sessions
├── session-removal.js  delete a session with its worktree and branch
├── desktop-workspace.js  read a desktop's layout (read-only)
├── desktop-sessions.js   read and watch the Claude desktop app's session files (read-only)
├── started-by.js       who started a session: the marks first, the desktop app's record after
├── store/              jsonl-table.js, entities.js
└── tools/              one file per area, plus context.js and common.js
test/                   node:test, one file per area or concern
```

## Adding or changing a tool

- Tools are `{ name, description, inputSchema, handler }`. Write the description for the model that will read it: what it does, its limits, what it will not do. Validate arguments in the handler and throw readable errors.
- A tool that is listed but not built uses `notYet(...)` from `tools/common.js`, so the whole surface is visible and honest.
- Anything that runs a program goes through `ctx.runtime.exec` / `spawnDetached` / `spawnProgram` so tests can replace it. Tests must never start a real `claude` or touch the real home folder: pass `configDir`, `dataDir` and a fake `runtime` (see `test/helpers.js`).
- Add the tool to the README tables (regenerate them from `AREAS`; do not hand-edit counts).

## Testing

```sh
npm test         # node --test test/*.test.js; nothing to install
```

- Write the failing test first, watch it fail for the right reason, then implement.
- A test that asserts "unavailable" must match `/^Error: unavailable: /`, not just the word. A loose match once hid a ReferenceError.
- Tests that use git create real throwaway repositories under the OS temp folder. Keep them independent of the user's git configuration.
- Compare paths with `path.resolve`, never hard-coded `/` strings: the suite also runs on Windows.

## Release

Order is always: tests pass, commit the change, commit the version bump (`package.json` only, message is the version), **`git push origin main`**, confirm the push, then `npm publish`, then confirm with `npm view @swttch/session-manager-mcp dist-tags` (it can take a minute or two). Never publish before pushing, and treat a request to publish as a request to push as well.

`npm pack --dry-run` should list only `src/`, `README.md`, `LICENSE` and `package.json`.

## Related products

- **Swttch JetBrains plugin**: its Node backend hands this server to the CLI with `--mcp-config` and records, in the CLI registry, how to reach the backend that runs each session. That registry file format is a contract; see `src/owner-control.js`.
- **Swttch Desktop**: reads the files described above and mirrors them for its screens; it also writes `workspace.json`, which `src/desktop-workspace.js` reads.
- **`@swttch/extend-kit`**: holds the saved Claude login. This package never reads credentials; plan limits (`get_usage`) are obtained by running `swttch-ext api oauth usage` (and `ccb oauth usage --json` on installs older than extend-kit 0.11). Never import extend-kit.
