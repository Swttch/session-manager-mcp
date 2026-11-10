// Telling a session that a session it started has ended its turn.
//
// The server that started the session is the one watching it, so the report exists only while the
// calling session's own CLI (and with it this server) is still running. It goes through the program
// that holds the calling session, the same way send_message reaches a running session, with the same first line. A calling
// session that nothing can write to (a terminal, a program without a control route) gets no report.

import { lastAssistantText } from './cli-sessions.js';
import { framePeerMessage } from './tools/common.js';

export const EXCERPT_LENGTH = 400;

function describeEnd(ctx, { sessionId, exitCode }) {
  let reply = null;
  try {
    reply = lastAssistantText({ configDir: ctx.configDir, sessionId });
  } catch {
    // No transcript yet: the session ended before it wrote one.
  }
  if (!reply) return `It ended without a reply (exit code ${exitCode ?? 'unknown'}).`;
  if (reply.length <= EXCERPT_LENGTH) return `Its last reply:\n${reply}`;
  return `The first ${EXCERPT_LENGTH} characters of its last reply (read the rest with list_events):\n${reply.slice(0, EXCERPT_LENGTH)}`;
}

/**
 * Sends the calling session one message about the session it started. Never throws: nobody is
 * waiting for this, so a failure here must not take the server down or surface anywhere.
 *
 * @returns {Promise<'delivered' | 'undelivered'>}
 */
export async function reportTurnEnd(ctx, { parentSessionId, sessionId, title, exitCode }) {
  try {
    // A session that was detached in the meantime answers to nobody.
    const mark = ctx.store?.marks.find(sessionId);
    if (mark && mark.parentSessionUid !== parentSessionId) return 'undelivered';
    const owner = await ctx.owners.find(parentSessionId);
    if (!owner) return 'undelivered';
    const text = framePeerMessage({
      from: sessionId,
      name: title,
      body: `This session, which you started, has ended its turn. ${describeEnd(ctx, { sessionId, exitCode })}`,
    });
    await ctx.owners.control(owner, { sessionId: parentSessionId, action: 'send_message', text });
    return 'delivered';
  } catch {
    return 'undelivered';
  }
}
