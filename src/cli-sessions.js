// Read-only access to the session transcripts the Claude CLI writes to disk
// (<config dir>/projects/<encoded cwd>/<session id>.jsonl). Nothing here needs a
// running app: this is the layer that lets the MCP work without Swttch Desktop.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function defaultConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function projectDirs(configDir) {
  const root = path.join(configDir, 'projects');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(root, d.name));
}

function transcriptFiles(configDir) {
  const files = [];
  for (const dir of projectDirs(configDir)) {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(dir, name);
      files.push({ file, sessionId: name.slice(0, -'.jsonl'.length), mtimeMs: fs.statSync(file).mtimeMs });
    }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function readEntries(file) {
  const entries = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // A half-written last line is normal while a session is running.
    }
  }
  return entries;
}

function contentText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block?.type === 'tool_use') parts.push(`[tool: ${block.name}]`);
    else if (block?.type === 'tool_result') parts.push(typeof block.content === 'string' ? block.content : '[tool result]');
  }
  return parts.join('\n');
}

function summarize(file, sessionId, mtimeMs) {
  let customTitle;
  let aiTitle;
  let firstPrompt;
  let cwd;
  for (const entry of readEntries(file)) {
    if (entry.type === 'custom-title' && entry.customTitle) customTitle = entry.customTitle;
    else if (entry.type === 'ai-title' && entry.aiTitle) aiTitle = entry.aiTitle;
    else if (entry.type === 'user' && firstPrompt === undefined) {
      const text = contentText(entry.message).trim();
      if (text) firstPrompt = text.slice(0, 80);
    }
    if (!cwd && typeof entry.cwd === 'string') cwd = entry.cwd;
  }
  return {
    sessionId,
    title: customTitle ?? aiTitle ?? firstPrompt ?? sessionId,
    // The name someone gave the session (`/rename`, `--name`), as opposed to one the CLI made up.
    customTitle: customTitle ?? null,
    cwd: cwd ?? null,
    lastActivityAt: new Date(mtimeMs).toISOString(),
  };
}

export function listCliSessions({ configDir = defaultConfigDir(), limit = 20, accept } = {}) {
  // `accept` is applied before a transcript is read, so filtering by marks stays cheap.
  const files = transcriptFiles(configDir).filter((f) => !accept || accept(f.sessionId));
  return files.slice(0, limit).map((f) => summarize(f.file, f.sessionId, f.mtimeMs));
}

export function countCliSessions({ configDir = defaultConfigDir() } = {}) {
  return transcriptFiles(configDir).length;
}

export function findCliSession({ configDir = defaultConfigDir(), sessionId }) {
  const found = transcriptFiles(configDir).find((f) => f.sessionId === sessionId);
  if (!found) throw new Error(`Session not found: ${sessionId}`);
  return found;
}

export function getCliSession({ configDir = defaultConfigDir(), sessionId }) {
  const found = findCliSession({ configDir, sessionId });
  return summarize(found.file, found.sessionId, found.mtimeMs);
}

export function searchCliSessions({ configDir = defaultConfigDir(), query, limit = 20 }) {
  if (typeof query !== 'string' || query.trim().length < 2) {
    throw new Error('query must be at least 2 characters');
  }
  const needle = query.toLowerCase();
  const hits = [];
  for (const f of transcriptFiles(configDir)) {
    if (hits.length >= limit) break;
    for (const entry of readEntries(f.file)) {
      if (entry.type !== 'user' && entry.type !== 'assistant') continue;
      const text = contentText(entry.message);
      const at = text.toLowerCase().indexOf(needle);
      if (at === -1) continue;
      const start = Math.max(0, at - 60);
      hits.push({
        sessionId: f.sessionId,
        title: summarize(f.file, f.sessionId, f.mtimeMs).title,
        snippet: text.slice(start, at + needle.length + 60),
      });
      break;
    }
  }
  return hits;
}

export function readCliSessionEvents({ configDir = defaultConfigDir(), sessionId, limit = 40, beforeUuid }) {
  const { file } = findCliSession({ configDir, sessionId });
  let turns = readEntries(file).filter((e) => (e.type === 'user' || e.type === 'assistant') && e.uuid);
  if (beforeUuid) {
    const at = turns.findIndex((e) => e.uuid === beforeUuid);
    if (at !== -1) turns = turns.slice(0, at);
  }
  const page = turns.slice(-limit);
  const hasMore = turns.length > page.length;
  const text = page.map((e) => `[${e.type}${e.timestamp ? ` ${e.timestamp}` : ''}] ${contentText(e.message)}`).join('\n\n');
  return { text, cursor: hasMore && page.length > 0 ? page[0].uuid : null };
}

// The text of the last thing the assistant said in a session, or null when it has said nothing.
// Only text counts: a turn that ended on a tool call has no reply to quote.
export function lastAssistantText({ configDir = defaultConfigDir(), sessionId }) {
  const { file } = findCliSession({ configDir, sessionId });
  const entries = readEntries(file);
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== 'assistant') continue;
    const content = entry.message?.content;
    const text = typeof content === 'string' ? content
      : Array.isArray(content) ? content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n') : '';
    if (text.trim()) return text.trim();
  }
  return null;
}

export function transcriptSessionIds({ configDir = defaultConfigDir() } = {}) {
  return new Set(transcriptFiles(configDir).map((f) => f.sessionId));
}
