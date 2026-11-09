// The settings area: preferences kept in the setting_values table. Nothing reads them yet except
// the tools themselves and whatever screen mirrors the table later.

import { resolveContext } from './context.js';
import { SettingValue } from '../store/entities.js';

const PROTECTED = /^(main|master|staging|warm|prod-.*|release.*)$/;

const bool = (v) => { if (typeof v !== 'boolean') throw new Error('value must be true or false.'); return v; };
const oneOf = (...allowed) => (v) => { if (!allowed.includes(v)) throw new Error(`value must be one of: ${allowed.join(', ')}.`); return v; };

const DEFINITIONS = [
  { key: 'auto_archive_on_pr_close', label: 'Auto-archive sessions when their pull request closes', default: false, allowed: 'true | false', meaning: 'Archive a session automatically once its pull request merges or closes.', validate: bool },
  { key: 'auto_archive_inactive_days', label: 'Archive inactive sessions', default: 0, allowed: 'an integer number of days from 0 to 365 (0 = never)', meaning: 'Archive sessions with no activity for this many days (0 = never).',
    validate: (v) => { if (!Number.isInteger(v) || v < 0 || v > 365) throw new Error('value must be a whole number of days from 0 to 365.'); return v; } },
  { key: 'branch_prefix', label: 'Branch prefix', default: 'swttch', allowed: '1-40 letters, digits, ".", "_" or "-", starting with a letter or digit; not a protected name (main, master, staging, warm, prod-*, release*)', meaning: 'The prefix added to the branch names of new sessions.',
    validate: (v) => {
      if (typeof v !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(v)) throw new Error('branch prefix must be 1-40 letters, digits, ".", "_" or "-", starting with a letter or digit.');
      if (PROTECTED.test(v)) throw new Error(`"${v}" is a protected name and cannot be a branch prefix.`);
      return v;
    } },
  { key: 'permission_request_notifications', label: 'Permission request notifications', default: 'banner', allowed: '"off" | "badge" | "banner"', meaning: 'How the user is notified when a session needs approval and the app is in the background.', validate: oneOf('off', 'badge', 'banner') },
  { key: 'question_notifications', label: 'Question notifications', default: 'banner', allowed: '"off" | "badge" | "banner"', meaning: 'How the user is notified when a session asks them to choose between options.', validate: oneOf('off', 'badge', 'banner') },
  { key: 'task_complete_notifications', label: 'Task complete notifications', default: 'banner', allowed: '"off" | "banner"', meaning: 'How the user is notified when a session finishes and waits.', validate: oneOf('off', 'banner') },
  { key: 'connect_new_sessions_to_remote_control', label: 'Connect new sessions to remote control', default: false, allowed: 'true | false', meaning: 'Whether new sessions connect to remote access automatically.', validate: bool },
  { key: 'output_style', label: 'Output style', default: 'default', allowed: '"default" | "Concise" | "Explanatory" | "Learning" | "Proactive"', meaning: 'The default output style for new sessions.', validate: oneOf('default', 'Concise', 'Explanatory', 'Learning', 'Proactive') },
  { key: 'draw_attention_on_notifications', label: 'Draw attention on notifications', default: true, allowed: 'true | false', meaning: 'Bounce the Dock icon or flash the taskbar when a session needs attention and the app is not focused.', validate: bool },
  { key: 'notification_sound', label: 'Notification sound', default: 'system', allowed: '"system" | "none"', meaning: 'The sound notifications play.', validate: oneOf('system', 'none') },
  { key: 'keep_awake_while_working', label: 'Keep computer awake while sessions work', default: true, allowed: 'true | false', meaning: 'Keep the computer from idle-sleeping while any session is working.', validate: bool },
  { key: 'keep_awake_on_battery', label: 'Keep awake on battery power', default: true, allowed: 'true | false', meaning: 'Whether that hold is also taken on battery power.', validate: bool },
  { key: 'prompt_suggestions', label: 'Prompt suggestions', default: true, allowed: 'true | false', meaning: 'Show a suggested next prompt after each reply.', validate: bool },
];

export function createSettingsTools(options = {}) {
  const ctx = resolveContext(options);
  const valueOf = (def) => ctx.store.settings.find(def.key)?.value ?? def.default;

  return [
    {
      name: 'get_settings',
      description: 'Read the user\'s preferences: each comes back with its current value, the values set_setting accepts, and one line on what it does. Also reports, read-only, facts that cannot be changed from here.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => ({
        settings: DEFINITIONS.map((def) => ({ key: def.key, label: def.label, value: valueOf(def), current: String(valueOf(def)), allowed: def.allowed, meaning: def.meaning, settable: true })),
        read_only: [
          { name: 'worktree_location', value: 'Inside the project (<repo>/.swttch/worktrees)', note: 'Where new session worktrees are created. The folder is hidden from the project\'s git status through .git/info/exclude.' },
          { name: 'default_permission_mode', value: 'default', note: 'Permission modes are the user\'s to change, per session.' },
        ],
      }),
    },
    {
      name: 'set_setting',
      description: 'Change ONE of the user\'s preferences by its get_settings key. Only call it for a change the user asked for. Refused when the value is not allowed or the setting already has it.',
      inputSchema: {
        type: 'object',
        properties: { key: { type: 'string', enum: DEFINITIONS.map((d) => d.key) }, value: { description: 'true or false for switches, a whole number of days, or a string; get_settings lists what each key accepts.' } },
        required: ['key', 'value'],
      },
      handler: async ({ key, value }) => {
        const def = DEFINITIONS.find((d) => d.key === key);
        if (!def) throw new Error(`Unknown setting: ${key}`);
        const next = def.validate(value);
        if (valueOf(def) === next) throw new Error(`${key} already has that value.`);
        ctx.store.settings.save(new SettingValue({ key, value: next }));
        return `Set ${key} to ${next}.`;
      },
    },
  ];
}
