// Renaming a session where the CLI keeps its name.
//
// A session's name is the `custom-title` entry of its transcript: the terminal's session list, the
// editor extensions and the desktop apps all read it from there. A name kept in a file of ours would
// be seen by Swttch programs only, and would have to be reconciled with the CLI's own forever. This
// server does not write transcripts either, so the name is set by the CLI itself.
//
// Two ways to ask it, the quiet one first:
//
// 1. `control_request{subtype:"rename_session", source:"host"}`, which is how an editor tells the CLI that the
//    user renamed the session in the editor's own UI. The CLI records the `custom-title` entry and nothing
//    else, so the session's conversation gains no line. It is not documented, so this is a deliberate use of an
//    undocumented request; the reasons and the fallback are in the README ("Renaming a session").
// 2. The official `/rename <name>`, the command a terminal user types. It records the same name, but as a
//    command the user ran: the command and the CLI's answer ("Session renamed to: ...") are added to the
//    conversation. It is the fallback for a CLI that does not know the request.

/** The CLI caps a session name at 200 characters and keeps it on one line. */
const MAX_NAME_LENGTH = 200;

/** How the CLI begins its answer to `/rename`; the answer is English whatever the interface language. */
const RENAMED_REPLY_PREFIX = 'Session renamed to:';

const RENAME_TIMEOUT_MS = 30000;

let requestCounter = 0;

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

/** Reads one line of the CLI's stream-json output: the answer to our request, or nothing. */
function answerTo(requestId) {
  return (line) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return null;
    }
    if (event?.type !== 'control_response' || event.response?.request_id !== requestId) return null;
    return event.response.subtype === 'success' ? { ok: true } : { ok: false, error: event.response.error ?? 'rename_session was refused' };
  };
}

/**
 * Asks the CLI to record the name without adding anything to the conversation: `claude -p --resume <id>` in
 * stream-json mode, with the request as the first input line. The CLI continues the same session, makes no
 * model call, and ends once its input is closed after the answer. A CLI that predates the light start refuses
 * the flags, so the request is tried once more without them.
 *
 * @returns {Promise<{ ok: true } | { ok: false, why: string }>} never throws: `ok: false` sends the caller to `/rename`.
 */
async function requestQuietRename(runtime, { sessionId, name, cwd }) {
  if (typeof runtime.runClaudeUntil !== 'function') return { ok: false, why: 'this runtime cannot hold a request open' };
  const base = ['-p', '--resume', sessionId, '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
  let why = 'no answer';
  for (const args of [[...base, ...LIGHT_START], base]) {
    const requestId = `rename_session_${process.pid}_${Date.now()}_${requestCounter++}`;
    const input = `${JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'rename_session', title: name, source: 'host', session_id: sessionId } })}\n`;
    const result = await runtime.runClaudeUntil(args, { cwd, input, timeoutMs: RENAME_TIMEOUT_MS, until: answerTo(requestId) });
    if (result.matched?.ok) return { ok: true };
    // A refusal is the CLI's own answer: asking again without the flags would be refused the same way.
    if (result.matched) return { ok: false, why: result.matched.error };
    why = (result.stderr || `it exited with code ${result.code} before answering`).trim();
  }
  return { ok: false, why };
}

/**
 * Renames the session: the quiet request first, and the CLI's own `/rename <name>` when that is not answered.
 * `/rename` is run in a CLI started for it: `claude -p --resume <id>` reading the command from
 * stdin, so the name needs no quoting on any platform. It makes no model call. A CLI that predates
 * the light start refuses the flags, so the command is tried once more without them.
 *
 * @throws with the CLI's own words when it did not confirm the rename.
 */
export async function renameWithCli(runtime, { sessionId, name, cwd }) {
  if ((await requestQuietRename(runtime, { sessionId, name, cwd })).ok) return;
  const base = ['-p', '--resume', sessionId, '--output-format', 'text'];
  let last = null;
  for (const args of [[...base, ...LIGHT_START], base]) {
    last = await runtime.runClaude(args, { cwd, input: `/rename ${name}\n`, timeoutMs: RENAME_TIMEOUT_MS });
    if (last.code === 0 && last.stdout.trim().startsWith(RENAMED_REPLY_PREFIX)) return;
  }
  throw new Error(`The CLI did not rename session ${sessionId}: ${(last.stderr || last.stdout || `it exited with code ${last.code}`).trim()}`);
}
