// Renaming a session where the CLI keeps its name.
//
// A session's name is the `custom-title` entry of its transcript: the terminal's session list, the
// editor extensions and the desktop apps all read it from there. A name kept in a file of ours would
// be seen by Swttch programs only, and would have to be reconciled with the CLI's own forever. This
// server does not write transcripts either, so the name is set by the CLI itself, with the command a
// terminal user types: `/rename <name>`.

/** The CLI caps a session name at 200 characters and keeps it on one line. */
const MAX_NAME_LENGTH = 200;

/** How the CLI begins its answer to `/rename`; the answer is English whatever the interface language. */
const RENAMED_REPLY_PREFIX = 'Session renamed to:';

const RENAME_TIMEOUT_MS = 30000;

/**
 * Flags that start the CLI without the user's hooks, tools, settings files and MCP servers, none of
 * which a rename needs. Measured on 2.1.322: the rename takes 1 second with them and 5 without.
 */
const LIGHT_START = ['--restricted', '--strict-mcp-config'];

/** The name as the CLI will keep it, so the name reported back is the one that was recorded. */
export function normalizeSessionName(title) {
  if (typeof title !== 'string') return '';
  return Array.from(title.replace(/\s+/g, ' ').trim()).slice(0, MAX_NAME_LENGTH).join('').trim();
}

/**
 * Runs `/rename <name>` in a CLI started for it: `claude -p --resume <id>` reading the command from
 * stdin, so the name needs no quoting on any platform. It makes no model call. A CLI that predates
 * the light start refuses the flags, so the command is tried once more without them.
 *
 * @throws with the CLI's own words when it did not confirm the rename.
 */
export async function renameWithCli(runtime, { sessionId, name, cwd }) {
  const base = ['-p', '--resume', sessionId, '--output-format', 'text'];
  let last = null;
  for (const args of [[...base, ...LIGHT_START], base]) {
    last = await runtime.runClaude(args, { cwd, input: `/rename ${name}\n`, timeoutMs: RENAME_TIMEOUT_MS });
    if (last.code === 0 && last.stdout.trim().startsWith(RENAMED_REPLY_PREFIX)) return;
  }
  throw new Error(`The CLI did not rename session ${sessionId}: ${(last.stderr || last.stdout || `it exited with code ${last.code}`).trim()}`);
}
