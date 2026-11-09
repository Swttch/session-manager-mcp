import { randomUUID } from 'node:crypto';
import { describeWorkspace, readWorkspace } from '../desktop-workspace.js';
import { UiCommand } from '../store/entities.js';

// Shared by the window and view areas: read what the desktop shows, queue a change for it.
export function uiHelpers(ctx) {
  return {
    describe: () => describeWorkspace(readWorkspace(ctx.dataDir), ctx.selfSessionId),
    queue(type, args) {
      if (!readWorkspace(ctx.dataDir)) {
        throw new Error('unavailable: no Swttch Desktop has run on this data folder, so there is no screen to change.');
      }
      ctx.store.uiCommands.save(new UiCommand({ id: randomUUID(), type, args, requestedBy: ctx.selfSessionId ?? null }));
      return `queued: the desktop will carry out ${type} when it next reads its commands. The result is not reported back.`;
    },
  };
}
