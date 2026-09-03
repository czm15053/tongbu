import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { writeFileAtomic } from '../../core/atomic.js';
import { verifyWrittenTurns } from '../../core/verify.js';
import { parsePiSession } from './parse.js';
import type { ImportTurnsOpts } from '../adapter.js';
import type { ProcessEvent, SessionRef, TokenUsage, UnifiedTurn } from '../../core/types.js';

export function piSessionsRoot(): string {
  return join(homedir(), '.pi', 'agent', 'sessions');
}

/** `/Users/foo/bar` → `--Users-foo-bar--`（与本机 pi 目录一致） */
export function encodePiProjectDir(cwd: string): string {
  const inner = cwd.replace(/^\//, '').replaceAll('/', '-');
  return `--${inner}--`;
}

function nid(): string {
  return randomBytes(4).toString('hex');
}

type Line = Record<string, unknown>;

export async function importTurnsToPi(
  turns: UnifiedTurn[],
  cwd: string,
  into?: SessionRef,
  opts?: ImportTurnsOpts,
  sessionsRoot?: string,
): Promise<SessionRef> {
  if (!turns.some((t) => t.role === 'user' && t.text.trim())) {
    throw new Error('没有可迁移的用户消息');
  }
  const root = sessionsRoot ?? piSessionsRoot();
  const dir = join(root, encodePiProjectDir(cwd));
  await mkdir(dir, { recursive: true });

  let sessionId = into?.sessionId ?? randomUUID();
  let filePath = into?.filePath ?? join(dir, `${isoFileStamp()}_${sessionId}.jsonl`);
  let parentId: string | null = null;
  const out: Line[] = [];

  if (into && !opts?.replace) {
    const existing = await readFile(into.filePath, 'utf8').catch(() => '');
    for (const line of existing.split('\n')) {
      if (!line.trim()) continue;
      out.push(JSON.parse(line) as Line);
    }
    const last = out.at(-1);
    if (last && typeof last.id === 'string') parentId = last.id;
    sessionId = into.sessionId;
    filePath = into.filePath;
  } else if (into && opts?.replace) {
    const existing = await readFile(into.filePath, 'utf8').catch(() => '');
    const header = existing.split('\n').find((l) => l.includes('"type":"session"'));
    if (header) {
      const h = JSON.parse(header) as Line;
      out.push(h);
      if (typeof h.id === 'string') {
        sessionId = h.id;
        parentId = h.id;
      }
    }
    filePath = into.filePath;
    sessionId = into.sessionId;
  }

  if (!out.some((l) => l.type === 'session')) {
    const ts = new Date().toISOString();
    out.push({ type: 'session', version: 3, id: sessionId, timestamp: ts, cwd });
    parentId = sessionId;
  }

  for (const turn of turns) {
    if (turn.role === 'user') {
      parentId = pushMessage(out, parentId, 'user', turn.timestamp, [{ type: 'text', text: turn.text }]);
      continue;
    }
    const content: unknown[] = [];
    const hasToolEvents = turn.events?.some((e) => e.kind === 'tool_call' || e.kind === 'tool_result') ?? false;
    for (const ev of turn.events ?? []) {
      if (ev.kind === 'thinking') {
        content.push({ type: 'thinking', thinking: ev.detail ?? ev.summary });
      } else if (ev.kind === 'tool_call') {
        content.push({
          type: 'toolCall',
          id: ev.callId ?? nid(),
          name: ev.name ?? 'tool',
          arguments: ev.input ?? {},
        });
      }
    }
    // 没有工具调用时，把 final text 直接放在 assistant 消息里；
    // 有工具调用时，为了避免 Pi TUI 把 final text 显示在 toolResult 消息之前，
    // 先只发 thinking/toolCall，再把 final text 作为一条独立 assistant 消息跟在 toolResult 后面。
    if (!hasToolEvents && turn.text.trim()) content.push({ type: 'text', text: turn.text });
    const assistantMsgId = pushMessage(out, parentId, 'assistant', turn.timestamp, content, undefined, turn.usage);
    parentId = assistantMsgId;
    let toolResultIndex = 0;
    for (const ev of turn.events ?? []) {
      if (ev.kind !== 'tool_result') continue;
      const baseMs = Date.parse(ev.timestamp || turn.timestamp) || Date.now();
      // 确保 tool_result message 时间严格晚于 assistant message，避免 Pi TUI 排序错乱
      const shifted = new Date(baseMs + 1000 + toolResultIndex * 100).toISOString();
      toolResultIndex += 1;
      parentId = pushMessage(out, parentId, 'toolResult', shifted, [
        { type: 'text', text: ev.detail ?? ev.summary },
      ], ev);
    }
    if (hasToolEvents && turn.text.trim()) {
      const finalTs = new Date((Date.parse(turn.timestamp) || Date.now()) + 2000 + toolResultIndex * 100).toISOString();
      parentId = pushMessage(out, parentId, 'assistant', finalTs, [{ type: 'text', text: turn.text }], undefined, turn.usage);
    }
  }

  await mkdir(dirname(filePath), { recursive: true });
  await writeFileAtomic(filePath, out.map((l) => JSON.stringify(l)).join('\n') + '\n', {
    backup: Boolean(into?.filePath),
    verify: async (tmp) =>
      verifyWrittenTurns({
        parse: (p) => parsePiSession({ provider: 'pi', sessionId, filePath: p, cwd }),
        filePath: tmp,
        turns,
        provider: 'pi',
      }),
  });
  return { provider: 'pi', sessionId, filePath, cwd };
}

function pushMessage(
  out: Line[],
  parentId: string | null,
  role: string,
  timestamp: string,
  content: unknown[],
  ev?: ProcessEvent,
  usage?: TokenUsage,
): string {
  const id = nid();
  const ts = timestamp || new Date().toISOString();
  const message: Record<string, unknown> = { role, content, timestamp: Date.parse(ts) || Date.now() };
  if (role === 'toolResult' && ev?.callId) {
    message.toolCallId = ev.callId;
    message.toolName = ev.name ?? 'tool';
  }
  if (role === 'assistant') {
    // pi TUI footer 要求 assistant 消息必须带 usage，否则渲染时 uncaughtException 退出；
    // 有源侧真实 usage 时写入，否则仍以 0 占位兜底
    message.usage = {
      input: usage?.inputTokens ?? 0,
      output: usage?.outputTokens ?? 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { total: 0 },
    };
    message.provider = 'pi';
  }
  out.push({
    type: 'message',
    id,
    parentId,
    timestamp: ts,
    message,
  });
  return id;
}

function isoFileStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, 'Z');
}
