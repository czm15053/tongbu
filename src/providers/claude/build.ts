import { access, appendFile, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeFileAtomic } from '../../core/atomic.js';
import { verifyWrittenTurns } from '../../core/verify.js';
import { claudeBashInput, ENCRYPTED_THINKING, toClaudeToolName, turnHasContent } from '../../core/rich.js';
import { parseClaudeSession } from './parse.js';
import type { ProcessEvent, SessionRef, TokenUsage, UnifiedTurn } from '../../core/types.js';
import type { ImportTurnsOpts } from '../adapter.js';

/** Claude Code 项目目录编码：非 ASCII 字母数字一律 → `-`（与 cc-sessions 一致） */
export function encodeClaudeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

export function claudeProjectsDir(): string {
  return path.join(homedir(), '.claude', 'projects');
}

type ClaudeIdentity = { model: string; version?: string };

const DEFAULT_IDENTITY: ClaudeIdentity = { model: 'claude-sonnet-4-5' };

/** 从最近会话探测本机 Claude 的 model/version；探测不到用默认（对齐 cc-sessions detect_claude_identity） */
async function detectClaudeIdentity(projectsDir: string): Promise<ClaudeIdentity> {
  const files = await newestJsonlPaths(projectsDir, 10);
  let detectedVersion: string | undefined;
  for (const file of files) {
    let content: string;
    try {
      content = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    let fileVersion: string | undefined;
    for (const line of content.split('\n').slice(0, 200)) {
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      fileVersion ??= typeof record.version === 'string' ? record.version : undefined;
      if (record.type !== 'assistant') continue;
      const message = record.message as Record<string, unknown> | undefined;
      const model = typeof message?.model === 'string' ? message.model : undefined;
      const messageId = typeof message?.id === 'string' ? message.id : '';
      if (model?.startsWith('claude-') && !generatedOriginLabel(messageId)) {
        return { model, version: fileVersion ?? detectedVersion };
      }
    }
    detectedVersion ??= fileVersion;
  }
  return { ...DEFAULT_IDENTITY, version: detectedVersion };
}

/** 按 mtime 倒序取 projects 下的 .jsonl 会话文件（最多 max 个） */
async function newestJsonlPaths(projectsDir: string, max: number): Promise<string[]> {
  const collected: string[] = [];
  let dirs: string[];
  try {
    dirs = await readdir(projectsDir);
  } catch {
    return [];
  }
  for (const dir of dirs) {
    const dirPath = path.join(projectsDir, dir);
    let entries: string[];
    try {
      if (!(await stat(dirPath)).isDirectory()) continue;
      entries = await readdir(dirPath);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.endsWith('.jsonl')) collected.push(path.join(dirPath, entry));
    }
  }
  const withMtime = await Promise.all(
    collected.map(async (file) => {
      try {
        return { file, mtime: (await stat(file)).mtimeMs };
      } catch {
        return { file, mtime: 0 };
      }
    }),
  );
  return withMtime
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, max)
    .map((x) => x.file);
}

/** cc-sessions generated_origin_label：转换工具生成的 message id 不作为身份来源 */
function generatedOriginLabel(value: string): boolean {
  const v = value.toLowerCase();
  return ['cc-sessions', 'codex-import', 'external-import', 'external_import', 'external_agent', 'imported'].some(
    (label) => v.includes(label),
  );
}

function newMsgId(): string {
  return `msg_${randomUUID().replace(/-/g, '')}`;
}

/** UnifiedTurn[] → Claude JSONL 行（Rich：thinking / tool_use / tool_result / 最终 text） */
export function buildClaudeLines(
  turns: UnifiedTurn[],
  sessionId: string,
  cwd: string,
  identity: ClaudeIdentity,
  opts?: { parentUuid?: string | null; requireUser?: boolean },
): string[] {
  const lines: string[] = [];
  let parentUuid: string | null = opts?.parentUuid ?? null;
  let lastTimestamp = new Date().toISOString();
  let userCount = 0;

  const baseRecord = (): Record<string, unknown> => {
    const uuid = randomUUID();
    const record: Record<string, unknown> = {
      parentUuid,
      isSidechain: false,
      userType: 'external',
      cwd,
      sessionId,
      gitBranch: '',
      uuid,
      timestamp: lastTimestamp,
    };
    if (identity.version) record.version = identity.version;
    return record;
  };

  const assistantMessage = (content: unknown[], stopReason: string | null, usage?: TokenUsage): Record<string, unknown> => ({
    id: newMsgId(),
    type: 'message',
    role: 'assistant',
    model: identity.model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: usage?.inputTokens ?? 0, output_tokens: usage?.outputTokens ?? 0 },
  });

  const push = (record: Record<string, unknown>): void => {
    parentUuid = record.uuid as string;
    lines.push(JSON.stringify(record));
  };

  for (const turn of turns) {
    if (!turnHasContent(turn)) continue;
    if (turn.timestamp) lastTimestamp = turn.timestamp;

    if (turn.role === 'user') {
      userCount += 1;
      const record = baseRecord();
      record.type = 'user';
      const content: unknown[] = [{ type: 'text', text: turn.text }];
      for (const ev of turn.events ?? []) {
        const block = claudeImageBlock(ev);
        if (block) {
          content.push(block);
        } else if (ev.kind === 'text' && ev.attachment && ev.attachment.kind !== 'image') {
          // 非图片附件（如 opencode file part）：claude 无等价块，降级为占位文本，
          // 保证「不无声」——与 expectClaudeRoundTrip 的 user 侧变换对称
          const placeholder = (ev.detail ?? ev.summary ?? '').trim() || '[附件（无描述）]';
          content.push({ type: 'text', text: placeholder });
        }
      }
      record.message = { role: 'user', content };
      push(record);
      continue;
    }

    let lastCallId: string | undefined;
    const finalText = turn.text.trim();
    for (const ev of turn.events ?? []) {
      if (ev.kind === 'text' && (ev.detail ?? ev.summary).trim() === finalText) continue;
      emitClaudeEvent(ev, {
        baseRecord,
        assistantMessage,
        push,
        lastCallId,
        setLastCallId: (id) => {
          lastCallId = id;
        },
        usage: turn.usage,
      });
    }
    if (turn.text.trim()) {
      const record = baseRecord();
      record.type = 'assistant';
      record.message = assistantMessage([{ type: 'text', text: turn.text }], 'end_turn', turn.usage);
      push(record);
    }
  }
  if (userCount === 0 && (opts?.requireUser ?? true)) {
    throw new Error('没有可迁移的用户消息（无法构建可续聊的 Claude 会话）');
  }
  return lines;
}

/**
 * claude 写出侧的受控降级（round-trip 校验的期望模型）：
 * thinking 事件写为 `[思考] <detail>` 文本记录（伪造 thinking 块缺签名会破坏 resume），
 * 反解后 thinking 事件消失：有最终文本时被覆盖，无最终文本时文本停在最后一条 `[思考]` 记录；
 * 加密/空思考直接丢弃。全空 turn 也随之消失（对齐 stripEmptyEvents）。
 */
function expectClaudeRoundTrip(turns: UnifiedTurn[]): UnifiedTurn[] {
  const out: UnifiedTurn[] = [];
  for (const t of turns) {
    if (t.role !== 'assistant') {
      // user 侧非图片附件 → 占位文本会进 turn.text（与 build 的降级对称），预测到文本里
      const filePlaces = (t.events ?? [])
        .filter((e) => e.kind === 'text' && e.attachment && e.attachment.kind !== 'image')
        .map((e) => (e.detail ?? e.summary ?? '[附件（无描述）]').trim());
      if (filePlaces.length === 0) {
        out.push(t);
      } else {
        out.push({ ...t, text: [t.text.trim(), ...filePlaces].filter(Boolean).join('\n\n') });
      }
      continue;
    }
    const thinkings = (t.events ?? []).filter((e) => e.kind === 'thinking');
    const events = (t.events ?? []).filter((e) => e.kind !== 'thinking');
    const kept = thinkings.filter((e) => {
      const d = (e.detail ?? e.summary ?? '').trim();
      return d.length > 0 && d !== ENCRYPTED_THINKING;
    });
    let text = t.text;
    if (!text.trim() && kept.length) {
      const last = kept.at(-1)!;
      text = `[思考] ${(last.detail ?? last.summary ?? '').trim()}`;
    }
    if (!text.trim() && events.length === 0) continue;
    out.push({ ...t, text, events });
  }
  return out;
}

function emitClaudeEvent(
  ev: ProcessEvent,
  ctx: {
    baseRecord: () => Record<string, unknown>;
    assistantMessage: (content: unknown[], stopReason: string | null, usage?: TokenUsage) => Record<string, unknown>;
    push: (record: Record<string, unknown>) => void;
    lastCallId: string | undefined;
    setLastCallId: (id: string) => void;
    usage?: TokenUsage;
  },
): void {
  if (ev.kind === 'thinking') {
    const thinking = (ev.detail ?? ev.summary).trim();
    if (!thinking || thinking === ENCRYPTED_THINKING) return;
    const record = ctx.baseRecord();
    record.type = 'assistant';
    record.message = ctx.assistantMessage([{ type: 'text', text: `[思考] ${thinking}` }], null, ctx.usage);
    ctx.push(record);
    return;
  }
  if (ev.kind === 'tool_call') {
    const callId = ev.callId || `call_${randomUUID()}`;
    ctx.setLastCallId(callId);
    const name = toClaudeToolName(ev.name ?? 'tool');
    const input =
      name === 'Bash'
        ? claudeBashInput(ev)
        : ev.input && typeof ev.input === 'object'
          ? ev.input
          : { input: ev.detail ?? ev.summary };
    const record = ctx.baseRecord();
    record.type = 'assistant';
    record.message = ctx.assistantMessage([{ type: 'tool_use', id: callId, name, input }], 'tool_use', ctx.usage);
    ctx.push(record);
    return;
  }
  if (ev.kind === 'tool_result') {
    const callId = ev.callId || ctx.lastCallId || `call_${randomUUID()}`;
    const record = ctx.baseRecord();
    record.type = 'user';
    record.message = {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: callId, content: ev.detail ?? ev.summary, is_error: false }],
    };
    ctx.push(record);
    return;
  }
  if (ev.kind === 'text') {
    const block = claudeImageBlock(ev);
    if (block) {
      const record = ctx.baseRecord();
      record.type = 'assistant';
      record.message = ctx.assistantMessage([block], null, ctx.usage);
      ctx.push(record);
      return;
    }
    const text = (ev.detail ?? ev.summary).trim();
    if (!text) return;
    const record = ctx.baseRecord();
    record.type = 'assistant';
    record.message = ctx.assistantMessage([{ type: 'text', text }], null, ctx.usage);
    ctx.push(record);
  }
}

/** 带 attachment 的 text 事件 → 还原原生 image block；非图片附件返回 null */
function claudeImageBlock(ev: ProcessEvent): Record<string, unknown> | null {
  const a = ev.attachment;
  if (!a || a.kind !== 'image') return null;
  if (typeof a.data === 'string') {
    return {
      type: 'image',
      source: { type: 'base64', media_type: a.mediaType ?? 'image/png', data: a.data },
    };
  }
  if (typeof a.url === 'string') {
    return { type: 'image', source: { type: 'url', url: a.url } };
  }
  return null;
}

async function lastClaudeUuid(filePath: string): Promise<string | null> {
  const raw = await readFile(filePath, 'utf8');
  let last: string | null = null;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as { uuid?: unknown };
      if (typeof record.uuid === 'string') last = record.uuid;
    } catch {
      continue;
    }
  }
  return last;
}

/** 统一时间线 → 原生会话：无 into 则新建；有 into 且文件在则追加；replace 则整文件重写 */
export async function importTurnsToClaude(
  turns: UnifiedTurn[],
  cwd: string,
  into?: SessionRef,
  opts?: ImportTurnsOpts,
): Promise<SessionRef> {
  if (!path.isAbsolute(cwd)) {
    throw new Error(`cwd 必须是绝对路径: ${cwd}`);
  }
  const projectsDir = claudeProjectsDir();
  const identity = await detectClaudeIdentity(projectsDir);

  if (into?.filePath && opts?.replace) {
    if (turns.length === 0) return into;
    await mkdir(path.dirname(into.filePath), { recursive: true });
    const lines = buildClaudeLines(turns, into.sessionId, cwd, identity);
    await writeFileAtomic(into.filePath, lines.join('\n') + '\n', {
      backup: true,
      verify: async (tmp) =>
        verifyWrittenTurns({ parse: (p) => parseClaudeSession({ ...into, filePath: p }), filePath: tmp, turns, provider: 'claude', expect: expectClaudeRoundTrip }),
    });
    return into;
  }

  if (into?.filePath) {
    try {
      await access(into.filePath);
      if (turns.length === 0) return into;
      const parentUuid = await lastClaudeUuid(into.filePath);
      const lines = buildClaudeLines(turns, into.sessionId, cwd, identity, {
        parentUuid,
        requireUser: false,
      });
      if (lines.length === 0) return into;
      await appendFile(into.filePath, lines.join('\n') + '\n');
      return into;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  const projectDir = path.join(projectsDir, encodeClaudeProjectDir(cwd));
  await mkdir(projectDir, { recursive: true });
  const sessionId = randomUUID();
  const filePath = path.join(projectDir, `${sessionId}.jsonl`);
  const lines = buildClaudeLines(turns, sessionId, cwd, identity);
  await writeFileAtomic(filePath, lines.join('\n') + '\n', {
    verify: async (tmp) =>
      verifyWrittenTurns({
        parse: (p) => parseClaudeSession({ provider: 'claude', sessionId, filePath: p, cwd }),
        filePath: tmp,
        turns,
        provider: 'claude',
        expect: expectClaudeRoundTrip,
      }),
  });
  return { provider: 'claude', sessionId, filePath, cwd };
}
