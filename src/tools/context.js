import { defaultConfigDir } from '../cli-sessions.js';
import { createCliRuntime } from '../cli-runtime.js';
import { createOwnerClient } from '../owner-control.js';
import { defaultDataDir } from '../store/jsonl-table.js';
import { openStore } from '../store/entities.js';

export const SELF = 'self';

// Everything a tool area needs from its surroundings.
export function resolveContext({ configDir = defaultConfigDir(), dataDir = defaultDataDir(), selfSessionId, runtime, owners } = {}) {
  return { configDir, dataDir, selfSessionId, runtime: runtime ?? createCliRuntime(), owners: owners ?? createOwnerClient(), store: openStore({ dataDir }) };
}

export function resolveSessionId(ctx, sessionId) {
  if (sessionId !== SELF) return sessionId;
  if (!ctx.selfSessionId) {
    throw new Error('This server was not told which session is the calling session, so "self" cannot be resolved.');
  }
  return ctx.selfSessionId;
}

export function isCallingSession(ctx, sessionId) {
  return sessionId === SELF || (ctx.selfSessionId !== undefined && sessionId === ctx.selfSessionId);
}

export function unavailable(what) {
  return new Error(`unavailable: ${what}`);
}

// The sessions that started each other form families; "linked" lists the family of the caller.
export function familyOf(selfSessionId, marks) {
  if (!selfSessionId) return new Set();
  const edges = new Map();
  const link = (a, b) => {
    if (!edges.has(a)) edges.set(a, new Set());
    edges.get(a).add(b);
  };
  for (const mark of marks.values()) {
    if (mark.parentSessionUid) {
      link(mark.sessionUid, mark.parentSessionUid);
      link(mark.parentSessionUid, mark.sessionUid);
    }
  }
  const seen = new Set([selfSessionId]);
  const queue = [selfSessionId];
  while (queue.length > 0) {
    for (const next of edges.get(queue.shift()) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  seen.delete(selfSessionId);
  return seen;
}

export function sessionRow(summary, marks, groups, liveIds = new Set()) {
  const mark = marks.get(summary.sessionId);
  const group = mark?.groupId ? groups.get(mark.groupId) : undefined;
  const row = {
    ...summary,
    title: mark?.title ?? summary.title,
    isArchived: mark?.isArchived ?? false,
    isRunning: liveIds.has(summary.sessionId),
    group: group ? { id: group.id, name: group.name } : null,
    pinned: mark?.pinned ?? false,
    unread: mark?.unread ?? false,
  };
  if (mark?.model) row.model = mark.model;
  if (mark?.effort) row.effort = mark.effort;
  if (mark?.permissionMode) row.permissionMode = mark.permissionMode;
  if (mark?.parentSessionUid) row.startedBy = mark.parentSessionUid;
  if (mark?.handle) row.name = mark.handle;
  return row;
}

export function lookups(store) {
  return {
    marks: new Map(store.marks.all().map((m) => [m.sessionUid, m])),
    groups: new Map(store.groups.all().map((g) => [g.id, g])),
  };
}
