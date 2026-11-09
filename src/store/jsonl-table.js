// A table is one JSONL file: <root>/entities/<domain>/<table>.entity.jsonl. The shape
// matches the plugin's entity files on purpose (one JSON object per line, the later line
// for an id is the row, {"id":..,"deleted":true} removes it) so a reader of either
// side can read the other's file. This is a small separate implementation, not a copy
// of the plugin's entity layer; the two can be merged into one library later.
//
// Unlike the plugin's tables, ids here are strings (a session uid or a uuid), because
// several programs append to these files and a central counter would be a bottleneck.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function defaultDataDir() {
  return process.env.CCG_HOME || path.join(os.homedir(), '.claude-code-gui');
}

export class JsonlTable {
  constructor({ root = defaultDataDir(), domain, table }) {
    this.file = path.join(root, 'entities', domain, `${table}.entity.jsonl`);
  }

  readAll() {
    let text;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      // Never answer "no rows" for a file that exists but cannot be read: the next write
      // would look like every row was lost.
      throw new Error(`Table file unreadable: ${this.file} (${error.code ?? error.message})`);
    }
    const rows = new Map();
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue; // kept in the file, ignored when reading
      }
      if (row === null || typeof row !== 'object' || row.id === undefined) continue;
      if (row.deleted === true) rows.delete(row.id);
      else rows.set(row.id, row);
    }
    return [...rows.values()];
  }

  get(id) {
    return this.readAll().find((row) => row.id === id);
  }

  upsert(id, patch) {
    const row = { ...(this.get(id) ?? {}), ...patch, id };
    this.#append(row);
    return row;
  }

  remove(id) {
    this.#append({ id, deleted: true });
  }

  #append(row) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    let prefix = '';
    if (fs.existsSync(this.file)) {
      const size = fs.statSync(this.file).size;
      if (size > 0) {
        const fd = fs.openSync(this.file, 'r');
        try {
          const last = Buffer.alloc(1);
          fs.readSync(fd, last, 0, 1, size - 1);
          // A writer that died mid-line leaves no newline; start our line on a fresh one.
          if (last[0] !== 0x0a) prefix = '\n';
        } finally {
          fs.closeSync(fd);
        }
      }
    }
    fs.appendFileSync(this.file, `${prefix}${JSON.stringify(row)}\n`);
  }
}
