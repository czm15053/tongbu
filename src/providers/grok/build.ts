import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { writeFileAtomic } from '../../core/atomic.js';
import { verifyWrittenTurns } from '../../core/verify.js';
import { mergeConsecutiveAssistant } from '../../core/rich.js';
import { parseGrokSession } from './parse.js';
import type { ImportTurnsOpts } from '../adapter.js';
import type { ProcessEvent, SessionRef, UnifiedTurn } from '../../core/types.js';

export function grokSessionsRoot(): string {
  return path.join(homedir(), '.grok', 'sessions');
}

/** `/Users/foo/bar` → `%2FUsers%2Ffoo%2Fbar`（与 Grok 会话目录一致） */
export function encodeGrokProjectDir(cwd: string): string {
  return encodeURIComponent(cwd);
}

type ChatLine =
  | { type: 'system'; content: string }
  | { type: 'user'; content: Array<{ type: 'text'; text: string }>; synthetic_reason?: string }
  | {
      type: 'assistant';
      content: string;
      tool_calls?: Array<{ id: string; name: string; arguments: string }>;
      model_id?: string;
      model_fingerprint?: string;
      reasoning_effort?: string;
    }
  | { type: 'tool_result'; tool_call_id: string; content: string }
  | { type: 'reasoning'; id: string; summary: Array<{ type: 'summary_text'; text: string }>; encrypted_content?: string; status?: string }
  | { type: string };

function defaultModelId(): string {
  return 'grok-4.5-build-free';
}

function systemLine(): ChatLine {
  return {
    type: 'system',
    content:
      'You are Grok, an interactive CLI assistant. Help the user with software engineering tasks.',
  };
}

function isoNow(): string {
  return new Date().toISOString();
}

function hashCwd(cwd: string): string {
  return createHash('sha256').update(cwd).digest('hex').slice(0, 12);
}

function slugFromCwd(cwd: string): string {
  const base = path.basename(cwd).replace(/[^a-zA-Z0-9]/g, '').toLowerCase().slice(0, 20) || 'workspace';
  return `${base}-${hashCwd(cwd).slice(0, 8)}`;
}

async function readChatLines(filePath: string): Promise<ChatLine[]> {
  const raw = await readFile(filePath, 'utf8').catch(() => '');
  const lines: ChatLine[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      lines.push(JSON.parse(line) as ChatLine);
    } catch {
      // ignore malformed
    }
  }
  return lines;
}

async function readSummary(filePath: string): Promise<Record<string, unknown> | null> {
  const raw = await readFile(filePath, 'utf8').catch(() => '');
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function findLatestGrokSession(
  cwd: string,
  sessionsRoot?: string,
): Promise<{ ref: SessionRef; updatedAt: number; preview?: string } | null> {
  const all = await listGrokSessions(cwd, sessionsRoot);
  return all[0] ?? null;
}

export async function listGrokSessions(
  cwd: string,
  sessionsRoot?: string,
): Promise<{ ref: SessionRef; updatedAt: number; preview?: string }[]> {
  const root = sessionsRoot ?? grokSessionsRoot();
  const dir = path.join(root, encodeGrokProjectDir(cwd));
  let entries: string[] = [];
  try {
    entries = (await (await import('node:fs/promises')).readdir(dir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }

  const items: { ref: SessionRef; updatedAt: number; preview?: string }[] = [];
  for (const id of entries) {
    const summaryPath = path.join(dir, id, 'summary.json');
    const summary = await readSummary(summaryPath);
    const updatedAtRaw =
      summary?.updated_at ?? summary?.last_active_at ?? summary?.created_at;
    let updatedAt = 0;
    if (typeof updatedAtRaw === 'string') {
      updatedAt = Date.parse(updatedAtRaw) || 0;
    } else if (typeof updatedAtRaw === 'number') {
      updatedAt = updatedAtRaw;
    }
    if (!updatedAt) {
      // 旧版 Grok 会话目录没有 summary.json，用 chat_history.jsonl mtime 兜底，否则排序全 0 不稳定
      updatedAt = (await stat(path.join(dir, id, 'chat_history.jsonl')).catch(() => undefined))?.mtimeMs ?? 0;
    }
    const preview =
      typeof summary?.generated_title === 'string'
        ? summary.generated_title
        : typeof summary?.session_summary === 'string'
          ? summary.session_summary
          : undefined;
    items.push({
      ref: { provider: 'grok', sessionId: id, filePath: path.join(dir, id, 'chat_history.jsonl'), cwd },
      updatedAt,
      preview,
    });
  }
  items.sort((a, b) => b.updatedAt - a.updatedAt);
  return items;
}

/**
 * 按原生 session id 全局反查 Grok 会话：遍历各 cwd 的编码目录，命中 <id>/ 即解码出 cwd
 * （目录名 URL 编码可逆）；summary.json 里若声明了 cwd 则以其为准。sessionsRoot 可注入供单测。
 */
export async function findGrokSessionById(
  sessionId: string,
  sessionsRoot?: string,
): Promise<{ ref: SessionRef; updatedAt: number; preview?: string } | null> {
  const root = sessionsRoot ?? grokSessionsRoot();
  let dirs: import('node:fs').Dirent[];
  try {
    dirs = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    let dirCwd: string;
    try {
      dirCwd = decodeURIComponent(d.name);
    } catch {
      continue;
    }
    const sessionDir = path.join(root, d.name, sessionId);
    const chatPath = path.join(sessionDir, 'chat_history.jsonl');
    try {
      const st = await stat(chatPath);
      if (!st.isFile()) continue;
      const summary = await readSummary(path.join(sessionDir, 'summary.json'));
      const info = summary?.info;
      const summaryCwd = typeof info === 'object' && info !== null ? (info as { cwd?: unknown }).cwd : undefined;
      const cwd = typeof summaryCwd === 'string' && summaryCwd ? summaryCwd : dirCwd;
      const preview =
        typeof summary?.generated_title === 'string'
          ? summary.generated_title
          : typeof summary?.session_summary === 'string'
            ? summary.session_summary
            : undefined;
      return {
        ref: { provider: 'grok', sessionId, filePath: chatPath, cwd },
        updatedAt: st.mtimeMs,
        preview,
      };
    } catch {
      continue;
    }
  }
  return null;
}

/** 在 Grok sessions 目录下建一个可 resume 的空会话 */
export async function createEmptyGrokSession(cwd: string, sessionsRoot?: string): Promise<SessionRef> {
  if (!path.isAbsolute(cwd)) {
    throw new Error(`cwd 必须是绝对路径: ${cwd}`);
  }
  const sessionId = randomUUID();
  const root = sessionsRoot ?? grokSessionsRoot();
  const dir = path.join(root, encodeGrokProjectDir(cwd), sessionId);
  await mkdir(dir, { recursive: true });
  const now = isoNow();
  const chatPath = path.join(dir, 'chat_history.jsonl');
  const summaryPath = path.join(dir, 'summary.json');
  await writeFile(chatPath, JSON.stringify(systemLine()) + '\n', 'utf8');
  const summary = {
    info: { id: sessionId, cwd },
    session_summary: `Imported - ${now}`,
    created_at: now,
    updated_at: now,
    num_messages: 1,
    num_chat_messages: 0,
    current_model_id: defaultModelId(),
    next_trace_turn: 1,
    chat_format_version: 1,
    request_id: randomUUID(),
    grok_home: path.join(homedir(), '.grok'),
    last_active_at: now,
    generated_title: `Imported - ${now}`,
    agent_name: 'grok-build',
    sandbox_profile: 'off',
    reasoning_effort: 'high',
  };
  await writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
  return { provider: 'grok', sessionId, filePath: chatPath, cwd };
}

function toolInputString(input: unknown): string {
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input ?? {});
  } catch {
    return String(input ?? '{}');
  }
}

function toolOutputString(output: unknown): string {
  if (typeof output === 'string') return output;
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

function buildAssistantLine(text: string, toolCalls: ProcessEvent[], modelId: string): ChatLine {
  const line: ChatLine = {
    type: 'assistant',
    content: text,
    model_id: modelId,
    reasoning_effort: 'high',
  };
  if (toolCalls.length > 0) {
    (line as { tool_calls?: Array<{ id: string; name: string; arguments: string }> }).tool_calls =
      toolCalls.map((ev) => ({
        id: ev.callId || `call_${randomUUID()}`,
        name: ev.name || 'tool',
        arguments: toolInputString(ev.input),
      }));
  }
  return line;
}

function buildToolResultLine(ev: ProcessEvent): ChatLine {
  return {
    type: 'tool_result',
    tool_call_id: ev.callId || 'unknown',
    content: toolOutputString(ev.detail ?? ev.summary ?? ''),
  };
}

function buildReasoningLine(ev: ProcessEvent): ChatLine {
  return {
    type: 'reasoning',
    id: `rs_${randomUUID()}`,
    summary: [{ type: 'summary_text', text: ev.detail ?? ev.summary ?? '思考中…' }],
    status: 'completed',
  };
}

/** 把 UnifiedTurn[] 写成 Grok chat_history.jsonl */
export async function importTurnsToGrok(
  turns: UnifiedTurn[],
  cwd: string,
  into?: SessionRef,
  opts?: ImportTurnsOpts,
  sessionsRoot?: string,
): Promise<SessionRef> {
  if (!path.isAbsolute(cwd)) {
    throw new Error(`cwd 必须是绝对路径: ${cwd}`);
  }
  if (!turns.some((t) => t.role === 'user' && t.text.trim())) {
    throw new Error('没有可迁移的用户消息');
  }
  // grok 格式无「连续 assistant 轮」概念（parse 的 ensureAssistant 会并回上一轮），
  // 导入前先合并，保证写回内容能被自家 parse 对称还原
  turns = mergeConsecutiveAssistant(turns);

  const ref = into ?? (await createEmptyGrokSession(cwd, sessionsRoot));
  const chatPath = ref.filePath;
  const summaryPath = path.join(path.dirname(chatPath), 'summary.json');

  let existing: ChatLine[] = [];
  if (into && !opts?.replace) {
    existing = await readChatLines(chatPath);
  }
  if (opts?.replace) {
    existing = [systemLine()];
  }
  if (existing.length === 0) {
    existing = [systemLine()];
  }

  const system = existing.find((l) => (l as { type?: string }).type === 'system') ?? systemLine();
  const kept = opts?.replace ? [system] : existing;

  const out: ChatLine[] = [...kept];
  let chatMsgCount = out.filter((l) => ['user', 'assistant'].includes((l as { type?: string }).type || '')).length;

  for (const turn of turns) {
    // 全空 turn（无文本无事件）写回后会被 parse 与后继合并成非空轮，与 verify 的输入侧
    // 过滤不对称，round-trip 会误报——与 verifyWrittenTurns 的 wanted 过滤保持一致
    if (!turn.text.trim() && (turn.events?.length ?? 0) === 0) continue;
    if (turn.role === 'user') {
      out.push({ type: 'user', content: [{ type: 'text', text: turn.text }] });
      chatMsgCount += 1;
      continue;
    }

    const thinkingEvents: ProcessEvent[] = [];
    const toolCalls: ProcessEvent[] = [];
    const toolResults: ProcessEvent[] = [];
    for (const ev of turn.events ?? []) {
      if (ev.kind === 'thinking') thinkingEvents.push(ev);
      else if (ev.kind === 'tool_call') toolCalls.push(ev);
      else if (ev.kind === 'tool_result') toolResults.push(ev);
    }

    for (const ev of thinkingEvents) {
      out.push(buildReasoningLine(ev));
    }

    if (toolCalls.length > 0) {
      // Grok TUI 期望 tool_calls 所在的 assistant 行 content 为空，
      // 最终文本单独作为下一条 assistant 行跟在 tool_result 后面。
      out.push(buildAssistantLine('', toolCalls, defaultModelId()));
      chatMsgCount += 1;

      // tool_result 按 callId 紧随对应 tool_call 之后
      const resultByCallId = new Map<string, ProcessEvent>();
      for (const ev of toolResults) {
        if (ev.callId) resultByCallId.set(ev.callId, ev);
      }
      for (const ev of toolCalls) {
        const result = ev.callId ? resultByCallId.get(ev.callId) : undefined;
        if (result) {
          out.push(buildToolResultLine(result));
          resultByCallId.delete(ev.callId!);
        }
      }
      // 未配对的 tool_result 也补上，避免丢信息
      for (const ev of resultByCallId.values()) {
        out.push(buildToolResultLine(ev));
      }

      if (turn.text.trim()) {
        out.push(buildAssistantLine(turn.text, [], defaultModelId()));
        chatMsgCount += 1;
      }
    } else {
      out.push(buildAssistantLine(turn.text, [], defaultModelId()));
      chatMsgCount += 1;
    }
  }

  await writeFileAtomic(chatPath, out.map((l) => JSON.stringify(l)).join('\n') + '\n', {
    backup: Boolean(into?.filePath),
    verify: async (tmp) =>
      verifyWrittenTurns({
        parse: (p) => parseGrokSession({ ...ref, filePath: p }),
        filePath: tmp,
        turns,
        provider: 'grok',
      }),
  });

  const summary = (await readSummary(summaryPath)) ?? {
    info: { id: ref.sessionId, cwd },
    session_summary: `Imported - ${isoNow()}`,
    created_at: isoNow(),
  };
  const now = isoNow();
  summary.updated_at = now;
  summary.last_active_at = now;
  summary.num_messages = out.length;
  summary.num_chat_messages = chatMsgCount;
  summary.current_model_id = defaultModelId();
  summary.grok_home = path.join(homedir(), '.grok');
  if (!summary.info || typeof summary.info !== 'object') {
    summary.info = { id: ref.sessionId, cwd };
  } else {
    (summary.info as Record<string, unknown>).id = ref.sessionId;
    (summary.info as Record<string, unknown>).cwd = cwd;
  }
  // summary 由 chat 派生、可再生：chat 写成功后再写，半写窗口内 chat 始终完整
  await writeFileAtomic(summaryPath, JSON.stringify(summary, null, 2));

  return ref;
}
