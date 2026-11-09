import { createConnectorsTools } from './tools/connectors.js';
import { createDirectoryTools } from './tools/directory.js';
import { createHostTools } from './tools/host.js';
import { createPrTools } from './tools/pr.js';
import { createSettingsTools } from './tools/settings.js';
import { createTurnTools } from './tools/turn.js';
import { createViewTools } from './tools/view.js';
import { createWindowTools } from './tools/window.js';
import { createSessionMgmtTools } from './tools/session-mgmt.js';
import { createSessionTools } from './tools/session.js';
import { createSidebarTools } from './tools/sidebar.js';

// One MCP server per area, named swttch_<area>, so a tool shows up to the model as
// mcp__swttch_<area>__<tool> and each area is a small server of its own.
export const AREAS = {
  session_mgmt: createSessionMgmtTools,
  session: createSessionTools,
  sidebar: createSidebarTools,
  host: createHostTools,
  pr: createPrTools,
  settings: createSettingsTools,
  directory: createDirectoryTools,
  connectors: createConnectorsTools,
  turn: createTurnTools,
  window: createWindowTools,
  view: createViewTools,
};

export function serverNameFor(area) {
  return `swttch_${area}`;
}
