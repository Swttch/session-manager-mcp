import { notYet } from './common.js';

export function createDirectoryTools() {
  return [
    notYet('change_directory', { path: { type: 'string' } }, ['path'], 'Move this session to a different project folder.', 'a session\'s folder is fixed when it starts'),
    notYet('request_directory', { path: { type: 'string' } }, [], 'Ask for access to a folder outside the session folder.', 'there is no folder picker or access grant to ask the user with here'),
  ];
}
