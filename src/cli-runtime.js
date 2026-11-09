// The only two things the tools need from a running Claude CLI, both through its
// documented command line: which sessions are alive right now (`claude agents --json`)
// and starting a headless turn (`claude --resume <id> -p ...`). Kept behind a tiny
// interface so tests can replace it without spawning a model.

import { exec as exec_, execFile, spawn } from 'node:child_process';
import fsSync from 'node:fs';

// Finds a program on PATH. On Windows a program is a file with one of the extensions the system runs
// (code is code.cmd, git is git.exe), so a bare name never matches there.
export function findExecutable(cmd, { platform = process.platform, pathEnv = process.env.PATH ?? '', pathExt = process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD', exists } = {}) {
  const win = platform === 'win32';
  const sep = win ? ';' : ':';
  const join = (dir, name) => (win ? `${dir.replace(/[\\/]+$/, '')}\\${name}` : `${dir.replace(/\/+$/, '')}/${name}`);
  const check = exists ?? ((file) => { try { fsSync.accessSync(file, fsSync.constants.X_OK); return fsSync.statSync(file).isFile(); } catch { return false; } });
  const exts = win ? (/\.[a-z0-9]+$/i.test(cmd) ? [''] : pathExt.split(';').filter(Boolean).map((e) => e.toLowerCase()).sort((a, b) => ['.exe', '.com', '.bat', '.cmd'].indexOf(a) - ['.exe', '.com', '.bat', '.cmd'].indexOf(b))) : [''];
  for (const dir of pathEnv.split(sep).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = join(dir, cmd + ext);
      if (check(candidate)) return candidate;
    }
  }
  return null;
}

// cmd.exe reads one command line: wrap an argument in quotes and double the quotes inside it.
export function quoteForCmd(arg) {
  return `"${String(arg).replace(/"/g, '""')}"`;
}

export function defaultClaudeBin() {
  return process.env.SWTTCH_CLAUDE_BIN || 'claude';
}

export function createCliRuntime({ claudeBin = defaultClaudeBin(), ttlMs = 3000 } = {}) {
  let cached = null;

  function listLive() {
    if (cached && Date.now() - cached.at < ttlMs) return Promise.resolve(cached.rows);
    return new Promise((resolve) => {
      execFile(claudeBin, ['agents', '--json'], { timeout: 15000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
        let rows = [];
        if (!error) {
          // Take the outermost bracketed span: a shell wrapper may print a notice around it.
          const start = stdout.indexOf('[');
          const end = stdout.lastIndexOf(']');
          if (start !== -1 && end > start) {
            try {
              const parsed = JSON.parse(stdout.slice(start, end + 1));
              if (Array.isArray(parsed)) rows = parsed;
            } catch {
              rows = [];
            }
          }
        }
        // A CLI that cannot list means "none known live", which is the safe reading only
        // for reporting; callers that would act on it also check again before they act.
        cached = { at: Date.now(), rows, ok: !error };
        resolve(rows);
      });
    });
  }

  function spawnDetached(args, cwd) {
    return new Promise((resolve, reject) => {
      const child = launch(claudeBin, args, { cwd, detached: true, stdio: 'ignore' });
      child.once('error', reject);
      child.once('spawn', () => {
        child.unref();
        cached = null; // the live list changes now
        resolve();
      });
    });
  }

  // Runs a program and reports how it ended instead of throwing, so tools can read git's or gh's own words.
  function exec(cmd, args, { cwd, timeoutMs = 60000 } = {}) {
    return new Promise((resolve) => {
      const onWindows = process.platform === 'win32';
      const resolved = onWindows ? findExecutable(cmd) : cmd;
      if (!resolved) return resolve({ code: 127, stdout: '', stderr: `${cmd} was not found on PATH.` });
      const viaShell = onWindows && /\.(cmd|bat)$/i.test(resolved);
      const run = viaShell ? (callback) => exec_(`${quoteForCmd(resolved)} ${args.map(quoteForCmd).join(' ')}`, { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, callback)
        : (callback) => execFile(resolved, args, { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, callback);
      run((error, stdout, stderr) => {
        if (!error) return resolve({ code: 0, stdout, stderr });
        resolve({ code: typeof error.code === 'number' ? error.code : 127, stdout: stdout ?? '', stderr: stderr || error.message });
      });
    });
  }

  // On Windows a .cmd or .bat file cannot be started directly: it goes through cmd.exe with quoted arguments.
  function launch(cmd, args, options) {
    if (process.platform === 'win32') {
      const resolved = findExecutable(cmd) ?? cmd;
      if (/\.(cmd|bat)$/i.test(resolved)) return spawn(`${quoteForCmd(resolved)} ${args.map(quoteForCmd).join(' ')}`, { ...options, shell: true, windowsHide: true });
      return spawn(resolved, args, { ...options, windowsHide: true });
    }
    return spawn(cmd, args, options);
  }

  function spawnProgram(cmd, args) {
    return new Promise((resolve, reject) => {
      const child = launch(cmd, args, { detached: true, stdio: 'ignore' });
      child.once('error', reject);
      child.once('spawn', () => { child.unref(); resolve(); });
    });
  }

  async function which(cmd) {
    return findExecutable(cmd);
  }

  return { claudeBin, listLive, spawnDetached, exec, spawnProgram, which, platform: process.platform };
}
