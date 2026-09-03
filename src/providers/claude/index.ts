import { execFile } from 'node:child_process';
import { resolveCli } from '../../core/platform.js';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { digestFile } from '../../core/atomic.js';
import type { FileDigest } from '../../core/atomic.js';
import type { ProviderAdapter } from '../adapter.js';
import type { ProcessEvent, SessionRef, UnifiedTurn } from '../../core/types.js';
import { streamCommand } from '../../core/streamCommand.js';
import { parseClaudeSession } from './parse.js';
import { claudeSessionUsage } from './usage.js';
import { claudeProjectsDir, encodeClaudeProjectDir, importTurnsToClaude } from './build.js';
import { claudeLineToProcessEvents, claudeResultFromStream } from './events.js';

const execFileAsync = promisify(execFile);

const UUID_JSONL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

/** 找 cwd 对应 projectDir 下 mtime 最新的 uuid 会话；目录不存在返回 null。projectsRoot 可注入供单测 */
export async function findLatestClaudeSession(
  cwd: string,
  projectsRoot?: string,
): Promise<{ ref: SessionRef; updatedAt: number } | null> {
  const root = projectsRoot ?? claudeProjectsDir();
  const projectDir = path.join(root, encodeClaudeProjectDir(cwd));
  let entries: string[];
  try {
    entries = await readdir(projectDir);
  } catch {
    return null;
  }
  let best: { filePath: string; sessionId: string; updatedAt: number } | null = null;
  for (const entry of entries) {
    if (!UUID_JSONL.test(entry)) continue;
    const filePath = path.join(projectDir, entry);
    try {
      const st = await stat(filePath);
      if (!st.isFile()) continue;
      const updatedAt = st.mtimeMs;
      if (!best || updatedAt > best.updatedAt) {
        best = { filePath, sessionId: entry.replace(/\.jsonl$/i, ''), updatedAt };
      }
    } catch {
      continue;
    }
  }
  if (!best) return null;
  return {
    ref: { provider: 'claude', sessionId: best.sessionId, filePath: best.filePath, cwd },
    updatedAt: best.updatedAt,
  };
}

/** 读 jsonl 前若干行里 user 消息携带的 cwd（目录名编码不可逆，cwd 只能从文件内容拿） */
async function claudeSessionCwd(filePath: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    return null;
  }
  for (const line of raw.split('\n').slice(0, 60)) {
    if (!line.trim()) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof rec.cwd === 'string' && rec.cwd) return rec.cwd;
    const msg = rec.message;
    if (typeof msg === 'object' && msg !== null && typeof (msg as { cwd?: unknown }).cwd === 'string') {
      return (msg as { cwd: string }).cwd;
    }
  }
  return null;
}

/**
 * 按原生 session id（UUID）全局反查 Claude 会话：扫各 cwd 的 projectDir，命中 uuid 文件后
 * 从文件内容读回 cwd。projectsRoot 可注入供单测。
 */
export async function findClaudeSessionById(
  sessionId: string,
  projectsRoot?: string,
): Promise<{ ref: SessionRef; updatedAt: number } | null> {
  if (!UUID_JSONL.test(`${sessionId}.jsonl`)) return null;
  const root = projectsRoot ?? claudeProjectsDir();
  let dirs: string[];
  try {
    dirs = await readdir(root);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const filePath = path.join(root, dir, `${sessionId}.jsonl`);
    try {
      const st = await stat(filePath);
      if (!st.isFile()) continue;
      const cwd = await claudeSessionCwd(filePath);
      if (!cwd) continue;
      return { ref: { provider: 'claude', sessionId, filePath, cwd }, updatedAt: st.mtimeMs };
    } catch {
      continue;
    }
  }
  return null;
}

/** cwd 对应 projectDir 下全部 uuid 会话，mtime 降序；preview 取首条用户消息 */
export async function listClaudeSessions(
  cwd: string,
  projectsRoot?: string,
): Promise<{ ref: SessionRef; updatedAt: number; preview?: string }[]> {
  const root = projectsRoot ?? claudeProjectsDir();
  const projectDir = path.join(root, encodeClaudeProjectDir(cwd));
  let entries: string[];
  try {
    entries = await readdir(projectDir);
  } catch {
    return [];
  }
  const items: { ref: SessionRef; updatedAt: number }[] = [];
  for (const entry of entries) {
    if (!UUID_JSONL.test(entry)) continue;
    const filePath = path.join(projectDir, entry);
    try {
      const st = await stat(filePath);
      if (!st.isFile()) continue;
      items.push({
        ref: { provider: 'claude', sessionId: entry.replace(/\.jsonl$/i, ''), filePath, cwd },
        updatedAt: st.mtimeMs,
      });
    } catch {
      continue;
    }
  }
  items.sort((a, b) => b.updatedAt - a.updatedAt);
  return Promise.all(
    items.slice(0, 50).map(async (item) => ({
      ...item,
      preview: (await claudeFirstUserText(item.ref.filePath)) ?? undefined,
    })),
  );
}

async function claudeFirstUserText(filePath: string): Promise<string | null> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf8');
  } catch {
    return null;
  }
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      if (record.type !== 'user' || record.isMeta === true) continue;
      const message = record.message as Record<string, unknown> | undefined;
      const text =
        typeof message?.content === 'string'
          ? message.content
          : Array.isArray(message?.content)
            ? (message.content as Record<string, unknown>[])
                .filter((b) => b.type === 'text' && typeof b.text === 'string')
                .map((b) => b.text as string)
                .join(' ')
            : '';
      const clean = text.replace(/\s+/g, ' ').trim();
      if (clean) return clean.slice(0, 80);
    } catch {
      continue;
    }
  }
  return null;
}
/**
 * claude -p --output-format stream-json --verbose：逐行流式吐出过程事件（onEvent），
 * result 事件取最终回复与 session_id
 */
async function runClaude(
  args: string[],
  cwd: string,
  onEvent?: (e: ProcessEvent) => void,
): Promise<Record<string, unknown>> {
  let stdout: string;
  try {
    const out = await streamCommand(
      'claude',
      ['-p', ...args, '--output-format', 'stream-json', '--verbose'],
      { cwd, timeout: 600_000 },
      (line) => {
        if (onEvent) for (const e of claudeLineToProcessEvents(line)) onEvent(e);
      },
    );
    stdout = out.stdout;
  } catch (error) {
    const stderr =
      typeof error === 'object' && error !== null && 'stderr' in error
        ? String((error as { stderr: unknown }).stderr).slice(0, 500)
        : String(error);
    throw new Error(`claude CLI 调用失败: ${stderr}`);
  }
  const result = claudeResultFromStream(stdout);
  if (!result) {
    throw new Error(`claude 输出缺少 result 事件: ${stdout.slice(0, 500)}`);
  }
  if (result.is_error === true || typeof result.result !== 'string') {
    throw new Error(`claude 会话出错: ${stdout.slice(0, 500)}`);
  }
  return result;
}

const replyTurn = (text: string): UnifiedTurn => ({
  role: 'assistant',
  text,
  timestamp: new Date().toISOString(),
  provider: 'claude',
});

export const claudeAdapter: ProviderAdapter = {
  id: 'claude',
  displayName: 'Claude Code',

  async detect(): Promise<boolean> {
    try {
      await execFileAsync(resolveCli('claude'), ['--version'], { timeout: 10_000 });
      return true;
    } catch {
      return false;
    }
  },

  parse: parseClaudeSession,
  importTurns: importTurnsToClaude,
  contentFingerprint(ref: SessionRef): Promise<FileDigest | null> {
    return digestFile(ref.filePath);
  },
  findLatestSession: findLatestClaudeSession,
  listSessions: (cwd) => listClaudeSessions(cwd),

  /** nezha 式启动：预写一条占位 user 消息，`claude --resume <id>` 进 PTY 后可直接交互（不经 exec 等首条回复） */
  async createEmptySession(cwd: string): Promise<SessionRef> {
    return importTurnsToClaude(
      [{ role: 'user', text: '我们开始吧。', timestamp: new Date().toISOString() }],
      cwd,
    );
  },

  /** 从零开聊：claude -p（不带 --resume）起新会话，从 result 事件取 session_id，文件路径可确定性推导 */
  async start(
    cwd: string,
    text: string,
    onEvent?: (e: ProcessEvent) => void,
  ): Promise<{ ref: SessionRef; turn: UnifiedTurn }> {
    const result = await runClaude([text], cwd, onEvent);
    const sessionId = result.session_id;
    if (typeof sessionId !== 'string' || !sessionId) {
      throw new Error(`claude 输出缺少 session_id: ${JSON.stringify(result).slice(0, 500)}`);
    }
    const ref: SessionRef = {
      provider: 'claude',
      sessionId,
      filePath: path.join(claudeProjectsDir(), encodeClaudeProjectDir(cwd), `${sessionId}.jsonl`),
      cwd,
    };
    return { ref, turn: replyTurn(result.result as string) };
  },

  /** claude -p --resume stream-json，result 事件的 result 字段为最终回复 */
  async send(ref: SessionRef, text: string, onEvent?: (e: ProcessEvent) => void): Promise<UnifiedTurn> {
    const result = await runClaude([text, '--resume', ref.sessionId], ref.cwd, onEvent);
    return replyTurn(result.result as string);
  },

  resumeCommand(ref: SessionRef): string {
    return `claude --resume ${ref.sessionId}`;
  },

  findById: findClaudeSessionById,

  sessionUsage: claudeSessionUsage,
};
