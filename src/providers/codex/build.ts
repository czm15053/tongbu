import { access, appendFile, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeFileAtomic } from '../../core/atomic.js';
import { verifyWrittenTurns } from '../../core/verify.js';
import { ENCRYPTED_THINKING, codexToolInput, toCodexToolName, turnHasContent } from '../../core/rich.js';
import { parseCodexSession } from './parse.js';
import type { ProcessEvent, SessionRef, TokenUsage, UnifiedTurn } from '../../core/types.js';
import type { ImportTurnsOpts } from '../adapter.js';

export function codexDir(): string {
  return path.join(homedir(), '.codex');
}

type CodexIdentity = { originator: string; cliVersion?: string; source: string };

const DEFAULT_IDENTITY: CodexIdentity = { originator: 'Codex Desktop', source: 'vscode' };
const FALLBACK_CLI_VERSION = '0.0.0';
/** 未在 config.toml 显式写 model_provider 时，Codex 自己按 openai 处理 */
const DEFAULT_PROVIDER = 'openai';

/** 从最近 5 个 rollout 的 session_meta 探测 originator/cli_version/source（对齐 detect_codex_identity） */
async function detectCodexIdentity(sessionsDir: string): Promise<CodexIdentity> {
  const files = await newestJsonlPaths(sessionsDir, 5);
  for (const file of files) {
    let content: string;
    try {
      content = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of content.split('\n').slice(0, 20)) {
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (record.type !== 'session_meta') continue;
      const payload = record.payload as Record<string, unknown> | undefined;
      if (!payload) continue;
      const originator = typeof payload.originator === 'string' ? payload.originator : undefined;
      const source = typeof payload.source === 'string' ? payload.source : undefined;
      // 跳过 exec 会话的身份：我们要让导入/新建会话走普通 interactive resume，避免被 resume 选择器排除
      if (!originator || generatedOriginLabel(originator) || source === 'exec') {
        continue; // 试下一个文件
      }
      return {
        originator,
        cliVersion: typeof payload.cli_version === 'string' ? payload.cli_version : undefined,
        source: source ?? 'vscode',
      };
    }
  }
  return { ...DEFAULT_IDENTITY };
}

/** 按 mtime 倒序取 sessions 下的 rollout .jsonl（最多 max 个） */
async function newestJsonlPaths(sessionsDir: string, max: number): Promise<string[]> {
  const collected: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 3) return;
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = path.join(dir, entry);
      try {
        if ((await stat(p)).isDirectory()) {
          await walk(p, depth + 1);
        } else if (entry.endsWith('.jsonl')) {
          collected.push(p);
        }
      } catch {
        continue;
      }
    }
  };
  await walk(sessionsDir, 0);
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

/** 转换工具生成的 originator 不作为身份来源（对齐 generated_origin_label） */
function generatedOriginLabel(value: string): boolean {
  const v = value.toLowerCase();
  return ['cc-sessions', 'codex-import', 'external-import', 'external_import', 'external_agent', 'imported'].some(
    (label) => v.includes(label),
  );
}

/** 读 config.toml 顶层 model_provider（只扫首个表头之前的行，避免 [model_providers.xxx] 子表误匹配） */
export async function readModelProvider(codexDirPath: string): Promise<string> {
  let raw: string;
  try {
    raw = await readFile(path.join(codexDirPath, 'config.toml'), 'utf8');
  } catch {
    return DEFAULT_PROVIDER;
  }
  const topLevel = raw.split(/^ *\[/m)[0] ?? '';
  const m = /^ *model_provider *= *"([^"]+)"/m.exec(topLevel);
  return m?.[1] ?? DEFAULT_PROVIDER;
}

/** 按 session id 定位 rollout 文件（sessions/YYYY/MM/DD/rollout-*-<id>.jsonl），找不到返回 null */
export async function findRolloutBySessionId(sessionsDir: string, sessionId: string): Promise<string | null> {
  const suffix = `-${sessionId}.jsonl`;
  const files = await newestJsonlPaths(sessionsDir, Number.MAX_SAFE_INTEGER);
  return files.find((f) => f.endsWith(suffix)) ?? null;
}

/** 验证文件名能被 codex 的 parse_timestamp_uuid_from_filename 解析（对齐 validate_rollout_filename） */
export function validateRolloutFilename(filePath: string): void {
  const stem = path.basename(filePath, '.jsonl');
  const rest = stem.startsWith('rollout-') ? stem.slice('rollout-'.length) : null;
  if (rest === null || rest.length < 37) {
    throw new Error(`rollout 文件名缺少前缀或过短: ${stem}`);
  }
  const uuidPart = rest.slice(rest.length - 37);
  if (!uuidPart.startsWith('-')) {
    throw new Error(`rollout 文件名 UUID 段格式异常: ${stem}`);
  }
  const uuid = uuidPart.slice(1);
  if (uuid.length !== 36 || (uuid.match(/-/g) ?? []).length !== 4) {
    throw new Error(`rollout 文件名 UUID 段不合法: ${stem}`);
  }
}

const tsSeconds = (timestamp: string): number | null => {
  const ms = Date.parse(timestamp);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
};

/** UnifiedTurn[] → Codex rollout v1 wire 行（Simple，对齐 build_codex_lines / CodexRolloutBuilder） */
export function buildCodexLines(
  turns: UnifiedTurn[],
  sessionId: string,
  cwd: string,
  provider: string,
  identity: CodexIdentity,
  now: Date,
  opts?: { includeMeta?: boolean; requireUser?: boolean },
): string[] {
  const importTs = now.toISOString(); // RFC3339 millis，所有 record 统一用导入时刻
  const lines: string[] = [];
  let responseItemBytes = 0;
  let lastModelVisibleTokens = 0;
  let turn: { turnId: string; startedAt: number | null } | null = null;
  let turnUsage: TokenUsage | undefined;
  let userCount = 0;
  const requireUser = opts?.requireUser ?? true;
  const includeMeta = opts?.includeMeta ?? true;

  const push = (type: string, payload: Record<string, unknown>): void => {
    lines.push(JSON.stringify({ timestamp: importTs, type, payload }));
  };

  if (includeMeta) {
    push('session_meta', {
      session_id: sessionId,
      id: sessionId,
      timestamp: importTs,
      cwd,
      originator: identity.originator,
      source: identity.source,
      model_provider: provider,
      cli_version: identity.cliVersion ?? FALLBACK_CLI_VERSION,
    });
  }

  const closeTurn = (completedAt: number | null): void => {
    if (!turn) return;
    const usage = {
      input_tokens: turnUsage?.inputTokens ?? 0,
      cached_input_tokens: 0,
      output_tokens: turnUsage?.outputTokens ?? 0,
      reasoning_output_tokens: 0,
      total_tokens: turnUsage ? turnUsage.inputTokens + turnUsage.outputTokens : lastModelVisibleTokens,
    };
    push('event_msg', {
      type: 'token_count',
      info: { total_token_usage: usage, last_token_usage: usage, model_context_window: null },
      rate_limits: null,
    });
    push('event_msg', {
      type: 'task_complete',
      turn_id: turn.turnId,
      last_agent_message: null,
      started_at: turn.startedAt,
      completed_at: completedAt,
    });
    turn = null;
  };

  for (const t of turns) {
    if (!turnHasContent(t)) continue;
    if (t.role === 'user') {
      closeTurn(null);
      turnUsage = undefined;
      userCount += 1;
      const startedAt = tsSeconds(t.timestamp);
      const turnId = randomUUID();
      push('event_msg', { type: 'task_started', turn_id: turnId, started_at: startedAt, model_context_window: null });
      push('turn_context', { turn_id: turnId, cwd });
      push('event_msg', { type: 'user_message', message: t.text });
      responseItemBytes += Buffer.byteLength(t.text);
      push('response_item', {
        type: 'message',
        id: `msg_${randomUUID()}`,
        role: 'user',
        content: [{ type: 'input_text', text: t.text }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      });
      turn = { turnId, startedAt };
    } else {
      turnUsage = t.usage;
      if (!turn) {
        if (requireUser) continue; // assistant 前无进行中 turn，跳过
        const startedAt = tsSeconds(t.timestamp);
        const turnId = randomUUID();
        push('event_msg', { type: 'task_started', turn_id: turnId, started_at: startedAt, model_context_window: null });
        push('turn_context', { turn_id: turnId, cwd });
        turn = { turnId, startedAt };
      }
      let lastCallId: string | undefined;
      const finalText = t.text.trim();
      for (const ev of t.events ?? []) {
        if (ev.kind === 'text' && (ev.detail ?? ev.summary).trim() === finalText) continue;
        emitCodexEvent(ev, push, lastCallId, (id) => {
          lastCallId = id;
        }, cwd, turn.turnId);
        responseItemBytes += Buffer.byteLength(ev.detail ?? ev.summary);
      }
      if (finalText) {
        responseItemBytes += Buffer.byteLength(t.text);
        lastModelVisibleTokens = Math.floor(responseItemBytes / 4);
        push('event_msg', { type: 'agent_message', message: t.text, phase: 'final_answer' });
        push('response_item', {
          type: 'message',
          id: `msg_${randomUUID()}`,
          role: 'assistant',
          phase: 'final_answer',
          content: [{ type: 'output_text', text: t.text }],
          internal_chat_message_metadata_passthrough: { turn_id: turn.turnId },
        });
      } else {
        lastModelVisibleTokens = Math.floor(responseItemBytes / 4);
      }
    }
  }
  if (userCount === 0 && requireUser) {
    throw new Error('没有可迁移的用户消息（无法构建可续聊的 Codex 会话）');
  }
  if (!includeMeta && lines.length === 0) return [];
  const lastTs = [...turns].reverse().find((t) => turnHasContent(t) && tsSeconds(t.timestamp) !== null);
  closeTurn(lastTs ? tsSeconds(lastTs.timestamp) : null);
  return lines;
}

function wrapExecInput(name: string, input: string, cwd: string): string {
  if (name !== 'exec' || input.includes('tools.exec_command')) return input;
  return `const r = await tools.exec_command({cmd:${JSON.stringify(input)},workdir:${JSON.stringify(cwd)},yield_time_ms:10000,max_output_tokens:4000}); text(r.output);\n`;
}

function pushCommentary(
  push: (type: string, payload: Record<string, unknown>) => void,
  text: string,
  turnId: string,
): void {
  push('event_msg', { type: 'agent_message', message: text, phase: 'commentary' });
  push('response_item', {
    type: 'message',
    id: `msg_${randomUUID()}`,
    role: 'assistant',
    phase: 'commentary',
    content: [{ type: 'output_text', text }],
    internal_chat_message_metadata_passthrough: { turn_id: turnId },
  });
}

function emitCodexEvent(
  ev: ProcessEvent,
  push: (type: string, payload: Record<string, unknown>) => void,
  lastCallId: string | undefined,
  setLastCallId: (id: string) => void,
  cwd: string,
  turnId: string,
): void {
  const meta = { turn_id: turnId };
  if (ev.kind === 'thinking') {
    const text = (ev.detail ?? ev.summary).trim();
    if (!text) return;
    push('response_item', {
      type: 'reasoning',
      id: `rs_${randomUUID().replace(/-/g, '')}`,
      summary: [{ type: 'summary_text', text }],
      internal_chat_message_metadata_passthrough: meta,
    });
    if (text !== ENCRYPTED_THINKING) pushCommentary(push, `思考: ${text}`, turnId);
    return;
  }
  if (ev.kind === 'tool_call') {
    const callId = ev.callId || `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    setLastCallId(callId);
    const name = toCodexToolName(ev.name ?? 'tool');
    const input = wrapExecInput(name, codexToolInput(ev), cwd);
    push('response_item', {
      type: 'custom_tool_call',
      id: `ctc_${randomUUID().replace(/-/g, '')}`,
      status: 'completed',
      call_id: callId,
      name,
      input,
      internal_chat_message_metadata_passthrough: meta,
    });
    const shown = name === 'exec' ? codexToolInput(ev) : `${name}: ${codexToolInput(ev)}`;
    pushCommentary(push, shown.length > 200 ? `${shown.slice(0, 199)}…` : shown, turnId);
    return;
  }
  if (ev.kind === 'tool_result') {
    const callId = ev.callId || lastCallId || `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    push('response_item', {
      type: 'custom_tool_call_output',
      id: `ctco_${randomUUID()}`,
      call_id: callId,
      output: ev.detail ?? ev.summary,
      internal_chat_message_metadata_passthrough: meta,
    });
    return;
  }
  if (ev.kind === 'text') {
    const text = (ev.detail ?? ev.summary).trim();
    if (!text) return;
    pushCommentary(push, text, turnId);
  }
}

/** 统一时间线 → 原生会话：无 into 则新建；有 into 且文件在则追加；replace 则整文件重写 */
export async function importTurnsToCodex(
  turns: UnifiedTurn[],
  cwd: string,
  into?: SessionRef,
  opts?: ImportTurnsOpts,
  buildOpts?: { includeMeta?: boolean; requireUser?: boolean },
): Promise<SessionRef> {
  if (!path.isAbsolute(cwd)) {
    throw new Error(`cwd 必须是绝对路径: ${cwd}`);
  }
  const now = new Date();
  const provider = await readModelProvider(codexDir());
  const identity = await detectCodexIdentity(path.join(codexDir(), 'sessions'));

  if (into?.filePath && opts?.replace) {
    if (turns.length === 0) return into;
    await mkdir(path.dirname(into.filePath), { recursive: true });
    const lines = buildCodexLines(turns, into.sessionId, cwd, provider, identity, now);
    await writeFileAtomic(into.filePath, lines.join('\n') + '\n', {
      backup: true,
      verify: async (tmp) =>
        verifyWrittenTurns({ parse: (p) => parseCodexSession({ ...into, filePath: p }), filePath: tmp, turns, provider: 'codex' }),
    });
    return into;
  }

  if (into?.filePath) {
    try {
      await access(into.filePath);
      if (turns.length === 0) return into;
      const lines = buildCodexLines(turns, into.sessionId, cwd, provider, identity, now, {
        includeMeta: false,
        requireUser: false,
      });
      if (lines.length === 0) return into;
      await appendFile(into.filePath, lines.join('\n') + '\n');
      return into;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  const sessionId = randomUUID();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const stamp =
    `${yyyy}-${mm}-${dd}T${String(now.getUTCHours()).padStart(2, '0')}` +
    `-${String(now.getUTCMinutes()).padStart(2, '0')}-${String(now.getUTCSeconds()).padStart(2, '0')}`;
  const dir = path.join(codexDir(), 'sessions', yyyy, mm, dd);
  const filePath = path.join(dir, `rollout-${stamp}-${sessionId}.jsonl`);
  validateRolloutFilename(filePath);
  const lines = buildCodexLines(turns, sessionId, cwd, provider, identity, now, buildOpts);
  await mkdir(dir, { recursive: true });
  await writeFileAtomic(filePath, lines.join('\n') + '\n', {
    verify: async (tmp) =>
      verifyWrittenTurns({
        parse: (p) => parseCodexSession({ provider: 'codex', sessionId, filePath: p, cwd }),
        filePath: tmp,
        turns,
        provider: 'codex',
      }),
  });
  return { provider: 'codex', sessionId, filePath, cwd };
}
