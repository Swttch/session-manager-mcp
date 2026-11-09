// The sidebar area: groups ("sections" are groups that the app draws as headed blocks),
// pinning, unread dots and the list view. Everything is stored in the marks files, so the
// tools work whether or not a Swttch program is open; a Swttch program reads the same
// files and shows the result.

import { countCliSessions } from '../cli-sessions.js';
import { SessionMark, SidebarGroup, SidebarView } from '../store/entities.js';
import { lookups, resolveContext, resolveSessionId } from './context.js';
import { randomUUID } from 'node:crypto';

const BUILT_IN_SECTIONS = ['pinned', 'routines', 'sessions'];
const VIEW_ENUMS = {
  group_by: ['date', 'project', 'state', 'custom', 'none'],
  status: ['active', 'archived', 'all'],
  sort_by: ['recency', 'alpha', 'created'],
  last_activity: [0, 1, 3, 7, 30],
};

function validName(name) {
  if (typeof name !== 'string' || name.length < 1) throw new Error('name must be 1 to 200 characters (it was empty).');
  if (name.length > 200) throw new Error('name must be 1 to 200 characters (it was longer than 200).');
  return name;
}

export function createSidebarTools(options = {}) {
  const ctx = resolveContext(options);
  const { store } = ctx;

  const markOf = (sessionId) => store.marks.find(sessionId) ?? new SessionMark({ sessionUid: sessionId });

  function requireGroup(groupId) {
    const group = store.groups.find(groupId);
    if (!group) throw new Error(`No sidebar group with id: ${groupId}`);
    return group;
  }

  function rejectBuiltIn(sectionId) {
    if (BUILT_IN_SECTIONS.includes(sectionId)) throw new Error(`"${sectionId}" is a built-in section and cannot be changed.`);
  }

  function createGroup(name) {
    const existing = store.groups.all();
    const order = existing.length === 0 ? 0 : Math.max(...existing.map((g) => g.order)) + 1;
    const group = store.groups.save(new SidebarGroup({ id: `cg-${randomUUID()}`, name: validName(name), order }));
    return { id: group.id, name: group.name };
  }

  function renameGroup(groupId, name) {
    const group = requireGroup(groupId);
    group.name = validName(name);
    store.groups.save(group);
    return `Renamed to "${group.name}".`;
  }

  function deleteGroup(groupId) {
    requireGroup(groupId);
    for (const mark of store.marks.all()) {
      if (mark.groupId === groupId) {
        mark.groupId = null;
        store.marks.save(mark);
      }
    }
    store.groups.remove(groupId);
    return 'Deleted. Its sessions are Ungrouped now.';
  }

  function viewOf(sectionId) {
    return store.views.find(sectionId) ?? new SidebarView({ sectionId });
  }

  const nameSchema = { type: 'string', description: 'Display name, 1 to 200 characters.' };

  return [
    {
      name: 'list_groups',
      description: 'List the custom sidebar groups in sidebar order.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const { marks } = lookups(store);
        return store.groups.all().sort((a, b) => a.order - b.order).map((g) => ({
          id: g.id,
          name: g.name,
          session_count: [...marks.values()].filter((m) => m.groupId === g.id).length,
          order: g.order,
        }));
      },
    },
    {
      name: 'create_group',
      description: 'Create a custom sidebar group and return its id. File sessions into it with move_sessions.',
      inputSchema: { type: 'object', properties: { name: nameSchema }, required: ['name'] },
      handler: async ({ name }) => createGroup(name),
    },
    {
      name: 'rename_group',
      description: 'Rename a custom sidebar group.',
      inputSchema: { type: 'object', properties: { group_id: { type: 'string' }, name: nameSchema }, required: ['group_id', 'name'] },
      handler: async ({ group_id, name }) => renameGroup(group_id, name),
    },
    {
      name: 'delete_group',
      description: 'Delete a custom sidebar group. Its sessions are not touched; they become Ungrouped. Only call it when the user asked to remove that group.',
      inputSchema: { type: 'object', properties: { group_id: { type: 'string' } }, required: ['group_id'] },
      handler: async ({ group_id }) => deleteGroup(group_id),
    },
    {
      name: 'list_sections',
      description: 'List the sidebar sections in order: the built-in ones (pinned, routines, sessions) and one per custom group.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const { marks } = lookups(store);
        const all = [...marks.values()];
        const groups = store.groups.all().sort((a, b) => a.order - b.order);
        const view = (id, defaults) => {
          const v = store.views.find(id);
          return { group_by: v?.groupBy ?? defaults.group_by, sort_by: v?.sortBy ?? 'recency', ascending: false };
        };
        const grouped = all.filter((m) => m.groupId).length;
        return [
          { id: 'pinned', kind: 'pinned', name: '', order: 0, session_count: all.filter((m) => m.pinned).length, ...view('pinned', { group_by: 'none' }), collapsed: false, shown: true },
          { id: 'routines', kind: 'routines', name: '', order: 1, session_count: 0, ...view('routines', { group_by: 'none' }), collapsed: true, shown: false },
          ...groups.map((g, i) => ({
            id: g.id, kind: 'manual', name: g.name, order: 2 + i,
            session_count: all.filter((m) => m.groupId === g.id).length,
            ...view(g.id, { group_by: 'none' }), collapsed: g.collapsed, shown: true,
          })),
          { id: 'sessions', kind: 'sessions', name: '', order: 2 + groups.length, session_count: Math.max(0, countCliSessions({ configDir: ctx.configDir }) - grouped), ...view('sessions', { group_by: 'date' }), collapsed: false, shown: true },
        ];
      },
    },
    {
      name: 'create_section',
      description: 'Create a sidebar section the user can file sessions under (the same record as create_group) and return its id.',
      inputSchema: { type: 'object', properties: { name: nameSchema }, required: ['name'] },
      handler: async ({ name }) => createGroup(name),
    },
    {
      name: 'rename_section',
      description: 'Rename a section that was created by you or the user. Built-in sections cannot be renamed.',
      inputSchema: { type: 'object', properties: { section_id: { type: 'string' }, name: nameSchema }, required: ['section_id', 'name'] },
      handler: async ({ section_id, name }) => {
        rejectBuiltIn(section_id);
        return renameGroup(section_id, name);
      },
    },
    {
      name: 'delete_section',
      description: 'Delete a section that was created by you or the user; its sessions move back to Sessions (Ungrouped). Built-in sections cannot be deleted.',
      inputSchema: { type: 'object', properties: { section_id: { type: 'string' } }, required: ['section_id'] },
      handler: async ({ section_id }) => {
        rejectBuiltIn(section_id);
        return deleteGroup(section_id);
      },
    },
    {
      name: 'move_sessions',
      description: 'File up to 100 sessions under a custom group, or pass group_id null (or section_id "sessions") to move them back to Ungrouped. Moving a pinned session into a group unpins it.',
      inputSchema: {
        type: 'object',
        properties: {
          session_ids: { type: 'array', items: { type: 'string' }, description: 'Session ids, "self" allowed.' },
          group_id: { description: 'Destination group id, or null for Ungrouped.' },
          section_id: { type: 'string', description: 'Destination section id, or "sessions" for Ungrouped. Use instead of group_id.' },
        },
        required: ['session_ids'],
      },
      handler: async ({ session_ids, group_id, section_id }) => {
        if (!Array.isArray(session_ids) || session_ids.length === 0) throw new Error('session_ids must name at least one session.');
        if (session_ids.length > 100) throw new Error('session_ids may hold at most 100 sessions.');
        const target = section_id !== undefined ? (section_id === 'sessions' ? null : section_id) : (group_id ?? null);
        if (target !== null) requireGroup(target);
        for (const raw of session_ids) {
          const mark = markOf(resolveSessionId(ctx, raw));
          mark.groupId = target;
          if (target !== null) mark.pinned = false;
          store.marks.save(mark);
        }
        return `Moved ${session_ids.length} session(s) ${target === null ? 'to Ungrouped' : `into ${target}`}.`;
      },
    },
    {
      name: 'set_pinned',
      description: 'Pin or unpin a session in the sidebar ("self" for the calling session). A pinned session is shown above every group.',
      inputSchema: { type: 'object', properties: { session_id: { type: 'string' }, pinned: { type: 'boolean' } }, required: ['session_id', 'pinned'] },
      handler: async ({ session_id, pinned }) => {
        const mark = markOf(resolveSessionId(ctx, session_id));
        mark.pinned = pinned === true;
        store.marks.save(mark);
        return pinned ? 'Pinned.' : 'Unpinned.';
      },
    },
    {
      name: 'set_unread',
      description: 'Mark a session unread (a dot) or read in the sidebar ("self" for the calling session).',
      inputSchema: { type: 'object', properties: { session_id: { type: 'string' }, unread: { type: 'boolean' } }, required: ['session_id', 'unread'] },
      handler: async ({ session_id, unread }) => {
        const mark = markOf(resolveSessionId(ctx, session_id));
        mark.unread = unread === true;
        store.marks.save(mark);
        return unread ? 'Marked unread.' : 'Marked read.';
      },
    },
    {
      name: 'mark_completed',
      description: 'Acknowledge a session\'s "needs input" or "failed" dot so it reads as completed ("self" for the calling session). The dot comes back by itself if the session needs attention again.',
      inputSchema: { type: 'object', properties: { session_id: { type: 'string' } }, required: ['session_id'] },
      handler: async ({ session_id }) => {
        const mark = markOf(resolveSessionId(ctx, session_id));
        mark.completedAt = Date.now();
        mark.unread = false;
        store.marks.save(mark);
        return 'Marked completed.';
      },
    },
    {
      name: 'set_view',
      description: 'Change how the sidebar lists sessions. Pass only the fields to change; returns the settings afterwards.',
      inputSchema: {
        type: 'object',
        properties: {
          group_by: { type: 'string', enum: VIEW_ENUMS.group_by },
          status: { type: 'string', enum: VIEW_ENUMS.status },
          sort_by: { type: 'string', enum: VIEW_ENUMS.sort_by },
          last_activity: { type: 'number', description: 'Days: 0 (all), 1, 3, 7 or 30.' },
          section_id: { type: 'string', description: 'A section id from list_sections. Absent or "sessions" changes the whole list.' },
        },
      },
      handler: async (args) => {
        for (const key of Object.keys(VIEW_ENUMS)) {
          if (args[key] !== undefined && !VIEW_ENUMS[key].includes(args[key])) {
            throw new Error(`${key} must be one of: ${VIEW_ENUMS[key].join(', ')}`);
          }
        }
        const sectionId = args.section_id ?? 'sessions';
        const view = viewOf(sectionId);
        if (args.group_by !== undefined) view.groupBy = args.group_by;
        if (args.status !== undefined) view.status = args.status;
        if (args.sort_by !== undefined) view.sortBy = args.sort_by;
        if (args.last_activity !== undefined) view.lastActivity = args.last_activity;
        store.views.save(view);
        return { section_id: sectionId, group_by: view.groupBy, status: view.status, sort_by: view.sortBy, last_activity: view.lastActivity };
      },
    },
  ];
}
