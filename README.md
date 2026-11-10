# @swttch/session-manager-mcp

An [MCP](https://modelcontextprotocol.io) server that lets one Claude Code session look after your other Claude Code sessions.

From inside a session you can ask Claude to list and search your sessions, read what another one did, send it a message or stop it, rename, pin, group and archive sessions, start new ones (optionally in their own git worktree), and check on the pull request a session opened.

It is a plain local process with **no runtime dependencies**. It talks to the Claude CLI only through its documented commands (`claude agents --json`, `claude --resume -p`, `claude mcp list`), reads the session transcripts the CLI writes to disk, and keeps its own small state in plain text files. It does not need Swttch, a desktop app, or a network connection to the Swttch project. Where a feature genuinely needs another program (for example a screen to show a layout), the tool says so instead of pretending.

> Part of [Swttch](https://github.com/Swttch/swttch). It also ships inside the Swttch Desktop and can be used on its own, as described here.

## Requirements

- Node.js 20 or newer
- The Claude Code CLI (`claude`) on your `PATH`
- Optional: `git` (worktrees, `sync_with_base_branch`), `gh` (pull request tools), and [`@swttch/extend-kit`](https://www.npmjs.com/package/@swttch/extend-kit) 0.11 or newer (plan limits in `get_usage`)

It runs on macOS, Linux and Windows. The test suite passes on all three.

## Quick start

Add one area as a server of its own:

```sh
claude mcp add swttch-sessions -- npx -y @swttch/session-manager-mcp --area session_mgmt
```

Then, inside any Claude Code session:

> List my five most recent sessions and tell me which ones are still running.
>
> Find the session where I debugged the websocket reconnect and show me how it ended.
>
> Send "please rebase on main" to the session called `fix-login`.

Each area is its own MCP server, so Claude sees tools as `mcp__swttch_<area>__<tool>` (for example `mcp__swttch_sidebar__create_group`). Add the areas you want. Together the eleven areas are 70 tools, which takes a real share of every session's context, so start with one or two:

```sh
claude mcp add swttch-sessions -- npx -y @swttch/session-manager-mcp --area session_mgmt
claude mcp add swttch-sidebar  -- npx -y @swttch/session-manager-mcp --area sidebar
```

You can also describe the servers in a `--mcp-config` file or a project `.mcp.json`:

```json
{
  "mcpServers": {
    "swttch_session_mgmt": {
      "command": "npx",
      "args": ["-y", "@swttch/session-manager-mcp", "--area", "session_mgmt"],
      "env": { "SWTTCH_SESSION_ID": "<the id of the calling session>" }
    }
  }
}
```

### Telling the server which session is calling

Many tools take `"self"` for the calling session. The server cannot learn its own session from the CLI, so a host that knows it (Swttch does) passes it as `SWTTCH_SESSION_ID`. Without it, tools that need `"self"` answer with a clear error, and everything else still works.

## Configuration

| Environment variable | Meaning | Default |
| --- | --- | --- |
| `SWTTCH_SESSION_ID` | The calling session. What `"self"` means in tool arguments. | unset |
| `CLAUDE_CONFIG_DIR` | Where the Claude CLI keeps its transcripts. | `~/.claude` |
| `CCG_HOME` | Where this server keeps marks, groups, proposals and settings. | `~/.claude-code-gui` |
| `SWTTCH_CLAUDE_BIN` | The `claude` program to run. | found on `PATH` |
| `SWTTCH_CWD` | The folder offered as the project folder by `list_start_targets`. | unset |

## What works without anything else

Tools fall into three layers, by what they need:

| Layer | Needs | Examples |
| --- | --- | --- |
| **Read** | the CLI's transcripts on disk | `list_sessions`, `search_session_transcripts`, `list_events` |
| **Control** | the CLI itself, or the program that is running the session | `send_message`, `stop_session`, `set_session_model`, `start_session`, `archive_session` |
| **Screen** | a Swttch Desktop that shows the sessions | `get_window_layout`, `open_session_in`, `show_pane` |

How control works depends on who is running the session:

- **Nobody is running it.** The server resumes it headlessly with `claude --resume <id> -p "<message>"`. Settings such as model, effort and permission mode are saved and applied when the session next starts.
- **A Swttch program is running it** (the JetBrains plugin, Swttch Desktop, or `swttch browser`). The server finds that program in the CLI registry and asks it to act on the live session: deliver a message, interrupt a turn, switch the model, change the permission mode.
- **A terminal, or any other app, is running it.** Nothing outside that process can write to its input, so the tools answer `unavailable: ...` and name the process that holds the session. They never pretend.

Screen tools do not draw anything. They append a request to a file that a Swttch Desktop watches; the tool answers `queued` and does not wait for the result. With no desktop having ever run, they answer `unavailable`.

## Tools

Status: **works** means it does what it says now; **needs Swttch Desktop** means it queues a request for a desktop to carry out; **not yet** means it is listed so the whole surface is visible, and answers `unavailable: <reason>` when called.

#### `session_mgmt` (21)

| Tool | What it does | Status |
| --- | --- | --- |
| `list_sessions` | List the user's other Claude Code sessions, most recently active first. | works |
| `get_session` | Get one session's details by id, or the calling session with "self". | works |
| `search_session_transcripts` | Search the message text of the user's sessions. | works |
| `list_events` | Read the recent turns of another session as plain text, oldest first. | works |
| `send_message` | Send a message to another session. | works |
| `stop_session` | Interrupt another session's in-flight turn. | works |
| `archive_session` | Archive a session: it leaves the default list and can be brought back with unarchive_session. | works |
| `unarchive_session` | Restore an archived session to the session list. | works |
| `delete_session` | Delete sessions for good: the transcript is removed and cannot be recovered. | works |
| `set_session_title` | Rename a session ("self" for the calling session). | works |
| `set_session_model` | Choose the model another session uses. | works |
| `set_session_effort` | Choose a session's effort level (low, medium, high, xhigh, max). | works |
| `set_session_permission_mode` | Choose the permission mode a session starts in. | works |
| `get_usage` | The account's plan limits (5-hour, weekly, per-model weekly) with percent used and reset time. | works |
| `set_session_fast_mode` | Turn fast mode on or off for a session. | not yet |
| `set_session_output_style` | Switch the output style one session writes in. | not yet |
| `set_remote_control` | Turn remote access on or off for a session. | not yet |
| `clear_session` | Clear a session's conversation (/clear). | not yet |
| `detach_session` | Move a session you started to the top level. | works |
| `set_session_parent` | Put a session under another one by hand, or take it to the top level. Only the record of who started whom changes. | works |
| `export_transcript` | Export a session's transcript as a zip. | not yet |

#### `session` (7)

| Tool | What it does | Status |
| --- | --- | --- |
| `start_session` | Start a separate Claude Code session for a task while you stay with the user. | works |
| `list_start_targets` | List where start_session can put a session: the folders sessions have run in on this computer. | works |
| `hand_off_to_session` | Move the task in progress into its own session. | not yet |
| `dismiss_task` | Withdraw a session proposal (made with start_session "own_initiative" or "offer") that the user has not started: it went stale, was done here after all, or you proposed a better one. | works |
| `move_to_cloud` | Continue this session as a cloud session. | not yet |
| `mark_chapter` | Mark the start of a new chapter in this session. | not yet |
| `read_widget_context` | Read context from an embedded interactive widget. | not yet |

#### `sidebar` (13)

| Tool | What it does | Status |
| --- | --- | --- |
| `list_groups` | List the custom sidebar groups in sidebar order. | works |
| `create_group` | Create a custom sidebar group and return its id. | works |
| `rename_group` | Rename a custom sidebar group. | works |
| `delete_group` | Delete a custom sidebar group. | works |
| `list_sections` | List the sidebar sections in order: the built-in ones (pinned, routines, sessions) and one per custom group. | works |
| `create_section` | Create a sidebar section the user can file sessions under (the same record as create_group) and return its id. | works |
| `rename_section` | Rename a section that was created by you or the user. | works |
| `delete_section` | Delete a section that was created by you or the user; its sessions move back to Sessions (Ungrouped). | works |
| `move_sessions` | File up to 100 sessions under a custom group, or pass group_id null (or section_id "sessions") to move them back to Ungrouped. | works |
| `set_pinned` | Pin or unpin a session in the sidebar ("self" for the calling session). | works |
| `set_unread` | Mark a session unread (a dot) or read in the sidebar ("self" for the calling session). | works |
| `mark_completed` | Acknowledge a session's "needs input" or "failed" dot so it reads as completed ("self" for the calling session). | works |
| `set_view` | Change how the sidebar lists sessions. | works |

#### `host` (7)

| Tool | What it does | Status |
| --- | --- | --- |
| `open_in_editor` | Open a file from this session's folder in the user's code editor (VS Code, Cursor, Windsurf or Zed), optionally at a line and column. | works |
| `reveal_path` | Show a file or folder from this session's folder in the system file manager, selected in its parent folder. | works |
| `request_keep_awake` | Keep the user's computer from idle-sleeping for work that must outlast the turn: about 30 minutes for "turn_end", about an hour for "session_idle". | works |
| `get_storage_usage` | Report how much disk the Claude Code conversation history uses on this computer, and the free space left. | works |
| `clean_up_worktrees` | Free disk by removing the worktrees of sessions with no activity in the last 30, 60 or 90 days. | works |
| `discard_kept_worktree` | Delete the worktree an archived session left on disk because it held uncommitted changes, discarding those changes for good. | works |
| `sync_with_base_branch` | Bring the session's branch up to date with its base branch: fetch the base from origin and merge it into the checked-out branch. | works |

#### `pr` (5)

| Tool | What it does | Status |
| --- | --- | --- |
| `get_status` | Read the pull request bound to a session ("self" by default), through gh: number, state, branches, review decision, mergeability and a summary of the checks. | works |
| `bind_pr` | Bind the calling session to a pull request by its URL, for a pull request that was not picked up on its own. | works |
| `unbind_pr` | Dismiss the bound pull request from this session; bind_pr restores it. | works |
| `set_auto_merge` | Enable or disable GitHub auto-merge on a pull request (github.com only). | works |
| `set_monitor` | Watch the session's pull request and wake the session on CI failures, conflicts and review comments. | not yet |

#### `settings` (2)

| Tool | What it does | Status |
| --- | --- | --- |
| `get_settings` | Read the user's preferences: each comes back with its current value, the values set_setting accepts, and one line on what it does. | works |
| `set_setting` | Change ONE of the user's preferences by its get_settings key. | works |

#### `directory` (2)

| Tool | What it does | Status |
| --- | --- | --- |
| `change_directory` | Move this session to a different project folder. | not yet |
| `request_directory` | Ask for access to a folder outside the session folder. | not yet |

#### `connectors` (3)

| Tool | What it does | Status |
| --- | --- | --- |
| `session_connectors_status` | List the MCP servers the Claude CLI knows (`claude mcp list`) and their state: connected, failed or needs_auth. | works |
| `reconnect_session_connector` | Re-dial a failed connector. | not yet |
| `set_session_connector_enabled` | Turn a connector on or off for this session. | not yet |

#### `turn` (2)

| Tool | What it does | Status |
| --- | --- | --- |
| `update_plan` | Keep the task list shown for this session. | works |
| `wrap_up` | Record the end-of-turn recap (two or three sentences: what is now true and where it stands) and, when the user must decide something, one short question with the buttons that answer it. | works |

#### `window` (4)

| Tool | What it does | Status |
| --- | --- | --- |
| `get_window_layout` | Describe the desktop window right now: its split-view panes (where each sits, which session it shows, which is focused) and where the calling session is showing, if anywhere. | works |
| `open_session_in` | Show another session next to this one: "split" adds a split-view pane, "window" opens a pop-out window, "focus" shows it in the main pane. | needs Swttch Desktop |
| `close_split` | Close a split-view pane that you opened with open_session_in; never a pane the user arranged. | needs Swttch Desktop |
| `set_sidebar_collapsed` | Collapse (true) or expand (false) the desktop's sidebar. | needs Swttch Desktop |

#### `view` (4)

| Tool | What it does | Status |
| --- | --- | --- |
| `get_layout` | Report where this session is on screen in the desktop (main window pane) and which side panes are open. | works |
| `show_pane` | Show one of this session's side panes beside the conversation: diff (optional path, diff_scope), file (path, line), terminal (tab_id), pr, tasks, plan, artifact or preview. | needs Swttch Desktop |
| `close_pane` | Close one of this session's side panes. | needs Swttch Desktop |
| `set_transcript_view` | Switch how a conversation is drawn: "normal" (tool calls collapsed), "thinking" (also shows thinking summaries) or "verbose" (everything expanded). | needs Swttch Desktop |

### Worktrees

`start_session` can run the new session in its own git worktree:

- `use_worktree: true` creates `<project>/.swttch/worktrees/<name>-<suffix>` on a new branch `<prefix>/<name>-<suffix>`. The prefix is the `branch_prefix` setting (default `swttch`). The folder is added to the project's local `.git/info/exclude`, so it never shows up in the project's own `git status`.
- Omitted: the session shares the caller's folder, unless the caller itself works in a worktree, in which case the new session gets one of its own.
- `use_worktree: false` always shares the folder.
- `archive_session` removes a clean worktree (the branch stays) and keeps one that has uncommitted changes, saying so. A later message to the archived session brings the worktree back.
- `delete_session`, `clean_up_worktrees` and `discard_kept_worktree` never discard uncommitted work unless you ask for it explicitly.

### Names

A session's name is the one the CLI keeps: the `custom-title` entry of its transcript, which the terminal's session list, the editor extensions and the desktop apps all read. `set_session_title` therefore never stores a name in a file of its own, and never writes the transcript itself:

- **A Swttch program is running the session.** That program is asked to rename it (`rename` on its control route), and its CLI records the name. Nothing is added to the conversation.
- **Otherwise.** The CLI's own `/rename <name>` is run for it: `claude -p --resume <id> --restricted --strict-mcp-config` with the command on stdin. It makes no model call and takes about a second; the command and the CLI's answer are added to that session's transcript. A CLI too old for the two flags is asked again without them.

When another program that cannot be asked (a terminal) is running the session, the name is still written, and the answer says that the program may write a name of its own back at the end of its next turn.

The title a session was started with is also kept in its mark, only so that the session can be listed in the moment before the CLI has written its transcript.

### Hearing back

When a session started with `start_session` ends its turn, the session that started it is sent one message: which session it is from, and its last reply (the first 400 characters when the reply is longer). `wake_when_done: false` turns that off, and the answer of `start_session` says whether it was set up. `detach_session` ends it too: a session moved to the top level leaves the family of the session that started it and no longer reports to it.

A message one session sends another (this report, and `send_message`) is plain text whose first line names the sender: `From <title> (session <id>):`. That line is a contract for programs that draw transcripts, which show the message as coming from that session. It is not the CLI's own `<cross-session-message>` tag, because the CLI drops a typed message that is only that tag.

The answer of `start_session` carries `session_id` and `cwd`, which is all a screen needs to open the new session. Its description asks Claude to mention the session as a link, `[title](#session_<session_id>)`, for a screen to turn into a way in.

The server that started the session is the one that waits for it. So the message is sent only while the calling session is still running, and only when the program that holds the calling session can deliver it (see "How control works" above). A calling session that a terminal holds hears nothing.

### Proposals

A session can suggest starting another one without starting it: `start_session` with `initiation: "own_initiative"` (a full brief) or `"offer"` (a title only) stores a proposal that expires after seven days. Nothing runs until someone starts it: either by calling `start_session` again with `proposal_id`, or by a click in a program that lists proposals. `dismiss_task` withdraws one.

## Data

Everything this server keeps is plain text, one JSON object per line, in `<CCG_HOME>/entities/<domain>/<table>.entity.jsonl`:

| File | Contents |
| --- | --- |
| `sidebar/session_marks` | pin, unread, archive, group, title, model, effort, permission mode, parent session, worktree, bound pull request |
| `sidebar/sidebar_groups` | named groups and their order |
| `sidebar/sidebar_views` | how the list is grouped and sorted |
| `session/start_proposals` | suggested sessions waiting for a decision |
| `session/session_plans` | a session's task list and last wrap-up |
| `session/setting_values` | preferences set through `set_setting` |
| `ui/ui_commands` | requests for a desktop to change what is on screen |

The later line for an id is the row, and a line `{"id": ..., "deleted": true}` removes it. A line that is not valid JSON is skipped and left alone. Writers only ever append, so several programs can use the same files. Session transcripts are never modified; `delete_session` removes them and says it cannot be undone.

## Safety

The tools can delete sessions, stop turns, merge branches and remove worktrees, so they are deliberately conservative:

- `delete_session` (at most 25 per call), `archive_session` and `stop_session` refuse the calling session, and skip sessions that another program is running.
- Worktrees and branches with uncommitted or unmerged work are kept unless `force_worktree_cleanup` / `include_uncommitted` is passed.
- File tools (`open_in_editor`, `reveal_path`) only accept paths inside the calling session's folder.
- `sync_with_base_branch` refuses to run over uncommitted changes and never pushes.
- Nothing is sent anywhere except by the commands you would run yourself (`claude`, `git`, `gh`, and `swttch-ext` for plan limits). The server opens no network port.
- Your MCP client's own permission prompts apply to every tool call. Read-only tools are good candidates for an allow list; delete, archive and stop are not.

## Development

```sh
git clone https://github.com/Swttch/session-manager-mcp
cd session-manager-mcp
npm test        # node --test, nothing to install
```

The code is plain ES modules with no build step and no dependencies. `src/cli.js` is the entry point, `src/areas.js` lists the areas, and each area lives in `src/tools/`. See [CLAUDE.md](CLAUDE.md) for the working rules.

## License

[MIT](LICENSE)
