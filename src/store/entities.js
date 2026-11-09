// Entities are classes. A plain object exists only at the file boundary (fromRow / toRow).

import { JsonlTable, defaultDataDir } from './jsonl-table.js';

export class SessionMark {
  constructor({
    sessionUid, archivedAt = 0, pinned = false, unread = false, groupId = null, completedAt = 0,
    title = null, model = null, effort = null, permissionMode = null, parentSessionUid = null, handle = null,
    startedAt = 0, cwd = null, prUrl = null, prDismissed = false, worktree = null,
  }) {
    this.sessionUid = sessionUid;
    // Title, model, effort and permission mode are what the user (or a tool) chose for the
    // session. A running CLI cannot be changed from outside, so they are applied when the
    // session is next started.
    this.title = title;
    this.model = model;
    this.effort = effort;
    this.permissionMode = permissionMode;
    // Which session started this one, and the short handle its family calls it by.
    this.parentSessionUid = parentSessionUid;
    this.handle = handle;
    // Set when this server started the session: the row can be listed before the CLI has
    // written the first line of its transcript.
    this.startedAt = startedAt;
    this.cwd = cwd;
    // The pull request the user or a tool bound to this session; prDismissed hides the one gh would find.
    this.prUrl = prUrl;
    this.prDismissed = prDismissed;
    // { repo, path, branch, sourceBranch } when this session works in a worktree this server made.
    this.worktree = worktree;
    this.archivedAt = archivedAt;
    this.pinned = pinned;
    this.unread = unread;
    this.groupId = groupId;
    this.completedAt = completedAt;
  }

  static fromRow(row) {
    return new SessionMark({ ...row, sessionUid: row.id });
  }

  get isArchived() {
    return this.archivedAt > 0;
  }

  toRow() {
    const { sessionUid, ...rest } = this;
    return { ...rest };
  }
}

export class SidebarGroup {
  constructor({ id, name, order = 0, collapsed = false, createdAt = Date.now() }) {
    this.id = id;
    this.name = name;
    this.order = order;
    this.collapsed = collapsed;
    this.createdAt = createdAt;
  }

  static fromRow(row) {
    return new SidebarGroup(row);
  }

  toRow() {
    const { id, ...rest } = this;
    return { ...rest };
  }
}

export class SidebarView {
  constructor({ sectionId, groupBy = 'date', status = 'active', sortBy = 'recency', lastActivity = 0 }) {
    this.sectionId = sectionId;
    this.groupBy = groupBy;
    this.status = status;
    this.sortBy = sortBy;
    this.lastActivity = lastActivity;
  }

  static fromRow(row) {
    return new SidebarView({ ...row, sectionId: row.id });
  }

  toRow() {
    const { sectionId, ...rest } = this;
    return { ...rest };
  }
}

export class SettingValue {
  constructor({ key, value }) {
    this.key = key;
    this.value = value;
  }

  static fromRow(row) {
    return new SettingValue({ ...row, key: row.id });
  }

  toRow() {
    return { value: this.value };
  }
}

// What a session's task list and last wrap-up said, kept so a screen can show them.
export class SessionPlan {
  constructor({ sessionUid, items = [], wrapUp = null, updatedAt = Date.now() }) {
    this.sessionUid = sessionUid;
    this.items = items;
    this.wrapUp = wrapUp;
    this.updatedAt = updatedAt;
  }

  static fromRow(row) {
    return new SessionPlan({ ...row, sessionUid: row.id });
  }

  toRow() {
    const { sessionUid, ...rest } = this;
    return { ...rest };
  }
}

// A request for the desktop to change what is on screen. The desktop mirrors this table and carries
// the commands out; the sender does not wait for the result.
export class UiCommand {
  constructor({ id, type, args = {}, requestedBy = null, createdAt = Date.now() }) {
    this.id = id;
    this.type = type;
    this.args = args;
    this.requestedBy = requestedBy;
    this.createdAt = createdAt;
  }

  static fromRow(row) {
    return new UiCommand(row);
  }

  toRow() {
    const { id, ...rest } = this;
    return { ...rest };
  }
}

// A session someone suggested starting. It starts only when the user says so (a click on its card, or
// telling the session that proposed it), and lapses after a week.
export class StartProposal {
  constructor({ id, initiation, title, brief = {}, requestedBy = null, createdAt = Date.now(), expiresAt = createdAt + 7 * 24 * 3600 * 1000, state = 'pending', sessionId = null, dismissReason = null }) {
    this.id = id;
    this.initiation = initiation;
    this.title = title;
    this.brief = brief;
    this.requestedBy = requestedBy;
    this.createdAt = createdAt;
    this.expiresAt = expiresAt;
    this.state = state;
    this.sessionId = sessionId;
    this.dismissReason = dismissReason;
  }

  static fromRow(row) {
    return new StartProposal(row);
  }

  toRow() {
    const { id, ...rest } = this;
    return { ...rest };
  }
}

class Collection {
  constructor(table, entityClass, idField) {
    this.table = table;
    this.entityClass = entityClass;
    this.idField = idField;
  }

  all() {
    return this.table.readAll().map((row) => this.entityClass.fromRow(row));
  }

  find(id) {
    const row = this.table.get(id);
    return row ? this.entityClass.fromRow(row) : undefined;
  }

  save(entity) {
    this.table.upsert(entity[this.idField], entity.toRow());
    return entity;
  }

  remove(id) {
    this.table.remove(id);
  }
}

export function openStore({ dataDir = defaultDataDir() } = {}) {
  const table = (name) => new JsonlTable({ root: dataDir, domain: 'sidebar', table: name });
  return {
    marks: new Collection(table('session_marks'), SessionMark, 'sessionUid'),
    groups: new Collection(table('sidebar_groups'), SidebarGroup, 'id'),
    views: new Collection(table('sidebar_views'), SidebarView, 'sectionId'),
    settings: new Collection(new JsonlTable({ root: dataDir, domain: 'session', table: 'setting_values' }), SettingValue, 'key'),
    proposals: new Collection(new JsonlTable({ root: dataDir, domain: 'session', table: 'start_proposals' }), StartProposal, 'id'),
    uiCommands: new Collection(new JsonlTable({ root: dataDir, domain: 'ui', table: 'ui_commands' }), UiCommand, 'id'),
    plans: new Collection(new JsonlTable({ root: dataDir, domain: 'session', table: 'session_plans' }), SessionPlan, 'sessionUid'),
  };
}
