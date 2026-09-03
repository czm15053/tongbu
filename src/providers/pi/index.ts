import { execFile } from 'node:child_process';
import { resolveCli } from '../../core/platform.js';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ProviderAdapter } from '../adapter.js';
import { digestFile, type FileDigest } from '../../core/atomic.js';
import type { SessionRef } from '../../core/types.js';
import { parsePiSession } from './parse.js';
import { encodePiProjectDir, importTurnsToPi, piSessionsRoot } from './build.js';

const execFileAsync = promisify(execFile);

export { encodePiProjectDir, piSessionsRoot };

export async function findLatestPiSession(
  cwd: string,
  sessionsRoot?: string,
): Promise<{ ref: SessionRef; updatedAt: number } | null> {
  const all = await listPiSessions(cwd, sessionsRoot);
  return all[0] ?? null;
}

export async function listPiSessions(
  cwd: string,
  sessionsRoot?: string,
): Promise<{ ref: SessionRef; updatedAt: number; preview?: string }[]> {
  const root = sessionsRoot ?? piSessionsRoot();
  const dir = path.join(root, encodePiProjectDir(cwd));
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const items: { ref: SessionRef; updatedAt: number }[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.jsonl')) continue;
    const filePath = path.join(dir, entry);
    try {
      const st = await stat(filePath);
      if (!st.isFile()) continue;
      const sessionId = sessionIdFromName(entry);
      items.push({
        ref: { provider: 'pi', sessionId, filePath, cwd },
        updatedAt: st.mtimeMs,
      });
    } catch {
      continue;
    }
  }
  items.sort((a, b) => b.updatedAt - a.updatedAt);
  return items;
}

function sessionIdFromName(name: string): string {
  const base = name.replace(/\.jsonl$/i, '');
  const us = base.lastIndexOf('_');
  return us >= 0 ? base.slice(us + 1) : base;
}

/** 读 jsonl 首条可解析记录拿 cwd（session 头事件带 cwd，目录名编码不可逆） */
async function piSessionCwd(filePath: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    return null;
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof rec.cwd === 'string' && rec.cwd) return rec.cwd;
    break;
  }
  return null;
}

/** 按原生 session id 全局反查 Pi 会话：扫各 cwd 目录匹配 `<timestamp>_<id>.jsonl`，cwd 从文件头读；sessionsRoot 可注入 */
export async function findPiSessionById(
  sessionId: string,
  sessionsRoot?: string,
): Promise<{ ref: SessionRef; updatedAt: number } | null> {
  const root = sessionsRoot ?? piSessionsRoot();
  let dirs: string[];
  try {
    dirs = await readdir(root);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    let files: string[];
    try {
      files = await readdir(path.join(root, dir));
    } catch {
      continue;
    }
    const hit = files.find((f) => f.endsWith('.jsonl') && f.slice(0, -'.jsonl'.length).endsWith(`_${sessionId}`));
    if (!hit) continue;
    const filePath = path.join(root, dir, hit);
    try {
      const st = await stat(filePath);
      const cwd = await piSessionCwd(filePath);
      if (!cwd) continue;
      return { ref: { provider: 'pi', sessionId, filePath, cwd }, updatedAt: st.mtimeMs };
    } catch {
      continue;
    }
  }
  return null;
}

export const piAdapter: ProviderAdapter = {
  id: 'pi',
  displayName: 'Pi',

  async detect(): Promise<boolean> {
    try {
      await execFileAsync(resolveCli('pi'), ['--version'], { timeout: 10_000 });
      return true;
    } catch {
      return false;
    }
  },

  parse: parsePiSession,
  importTurns: (turns, cwd, into, opts) => importTurnsToPi(turns, cwd, into, opts),

  contentFingerprint(ref: SessionRef): Promise<FileDigest | null> {
    return digestFile(ref.filePath);
  },
  findLatestSession: findLatestPiSession,
  listSessions: listPiSessions,

  /** nezha 式启动：预写一条占位 user 消息，让 `pi --session <id>` 进 PTY 后能直接交互 */
  async createEmptySession(cwd: string): Promise<SessionRef> {
    const turn: import('../../core/types.js').UnifiedTurn = {
      role: 'user',
      text: '我们开始吧。',
      timestamp: new Date().toISOString(),
    };
    return importTurnsToPi([turn], cwd);
  },

  async start(): Promise<never> {
    throw new Error('pi 仅支持 TUI resume，请用 tongbu switch pi');
  },
  async send(): Promise<never> {
    throw new Error('pi 仅支持 TUI resume，请用 tongbu switch pi');
  },

  resumeCommand(ref: SessionRef): string {
    return `pi --session ${ref.sessionId}`;
  },

  findById: findPiSessionById,
};
