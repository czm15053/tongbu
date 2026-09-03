import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import type { ImportTurnsOpts } from '../adapter.js';
import type { ProcessEvent, SessionRef, TokenUsage, UnifiedTurn } from '../../core/types.js';

export function opencodeDbPath(): string {
  if (process.env.TONG_OPENCODE_DB) return process.env.TONG_OPENCODE_DB;
  return path.join(homedir(), '.local', 'share', 'opencode', 'opencode.db');
}

export function opencodeSessionsRoot(): string {
  return path.join(homedir(), '.local', 'share', 'opencode');
}

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * opencode 原生 ascending ID：`prefix_` + 12 位 hex((ms<<12)+seq) + 12 位 base62 随机。
 * 必须按原生格式生成：part/message 排序以 id 作同时间 tiebreaker，且 opencode 的
 * Identifier.timestamp() 按 hex 解析前 12 位——base36 等自造格式会让它抛 BigInt 异常。
 */
function sortableId(prefix: string, timeMs: number, seq: number): string {
  const packed = (BigInt(Math.floor(timeMs)) << 12n) + BigInt(seq % 0x1000);
  let hex = packed.toString(16);
  hex = hex.length > 12 ? hex.slice(-12) : hex.padStart(12, '0');
  let random = '';
  const bytes = randomBytes(12);
  for (const b of bytes) random += BASE62[b % 62];
  return `${prefix}_${hex}${random}`;
}

function nowMs(): number {
  return Date.now();
}

function isoTimestamp(ms: number): string {
  return new Date(ms).toISOString();
}

function tsMs(timestamp: string): number {
  const ms = Date.parse(timestamp);
  return Number.isNaN(ms) ? Date.now() : ms;
}

export async function findLatestOpencodeSession(
  cwd: string,
): Promise<{ ref: SessionRef; updatedAt: number } | null> {
  const all = await listOpencodeSessions(cwd);
  return all[0] ?? null;
}

export async function listOpencodeSessions(
  cwd: string,
): Promise<{ ref: SessionRef; updatedAt: number; preview?: string }[]> {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(opencodeDbPath(), { readOnly: true });
  } catch {
    return [];
  }
  try {
    const rows = db
      .prepare('SELECT id, directory, title, time_updated FROM session WHERE directory = ? ORDER BY time_updated DESC')
      .all(cwd) as { id: string; directory: string; title: string; time_updated: number }[];
    return rows.map((r) => ({
      ref: { provider: 'opencode', sessionId: r.id, filePath: opencodeDbPath(), cwd: r.directory },
      updatedAt: r.time_updated,
      preview: r.title,
    }));
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

/** 按原生 session id 全局反查 OpenCode 会话：SQLite 读 session.directory 作 cwd；db 路径走 TONG_OPENCODE_DB */
export async function findOpencodeSessionById(
  sessionId: string,
): Promise<{ ref: SessionRef; updatedAt: number } | null> {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(opencodeDbPath(), { readOnly: true });
  } catch {
    return null;
  }
  try {
    const row = db
      .prepare('SELECT directory, time_updated FROM session WHERE id = ?')
      .get(sessionId) as { directory: string; time_updated: number } | undefined;
    if (!row) return null;
    return {
      ref: { provider: 'opencode', sessionId, filePath: opencodeDbPath(), cwd: row.directory },
      updatedAt: row.time_updated,
    };
  } catch {
    return null;
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

/** 库里最近一次建会话用的 schema 版本；空库保底（硬编码假版本号会被后续版本迁移逻辑误判） */
function latestSessionVersion(db: DatabaseSync): string {
  try {
    const row = db.prepare('SELECT version FROM session ORDER BY time_created DESC LIMIT 1').get() as { version?: string } | undefined;
    if (row?.version) return row.version;
  } catch { /* ignore */ }
  return '1.1.0';
}

function hashCwd(cwd: string): string {
  return createHash('sha256').update(cwd).digest('hex').slice(0, 12);
}

function slugFromCwd(cwd: string): string {
  const base = path.basename(cwd).replace(/[^a-zA-Z0-9]/g, '').toLowerCase().slice(0, 20) || 'workspace';
  return `${base}-${hashCwd(cwd).slice(0, 8)}`;
}

/**
 * 全新空库自举：opencode 首次运行前的 opencode.db 可能还不存在（或已建但无表）。
 * 只在缺表时建最小兼容 schema（对齐 opencode v1 结构，也是本模块写入/反解的依赖）；
 * 库里已有表（真 opencode 建过）则一律不动，避免与官方迁移打架。
 */
function ensureMinimalSchema(db: DatabaseSync): void {
  const tables = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name),
  );
  if (tables.has('session') && tables.has('message') && tables.has('part')) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS project (id TEXT PRIMARY KEY, worktree TEXT);
    CREATE TABLE IF NOT EXISTS session (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      parent_id TEXT,
      slug TEXT NOT NULL,
      directory TEXT NOT NULL,
      title TEXT NOT NULL,
      version TEXT NOT NULL,
      share_url TEXT,
      summary_additions INTEGER,
      summary_deletions INTEGER,
      summary_files INTEGER,
      summary_diffs TEXT,
      revert TEXT,
      permission TEXT,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      time_compacting INTEGER,
      time_archived INTEGER,
      workspace_id TEXT,
      path TEXT,
      agent TEXT,
      model TEXT,
      cost REAL DEFAULT 0 NOT NULL,
      tokens_input INTEGER DEFAULT 0 NOT NULL,
      tokens_output INTEGER DEFAULT 0 NOT NULL,
      tokens_reasoning INTEGER DEFAULT 0 NOT NULL,
      tokens_cache_read INTEGER DEFAULT 0 NOT NULL,
      tokens_cache_write INTEGER DEFAULT 0 NOT NULL,
      metadata TEXT
    );
    CREATE TABLE IF NOT EXISTS message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `);
}

export async function createEmptyOpencodeSession(cwd: string): Promise<SessionRef> {
  if (!path.isAbsolute(cwd)) throw new Error(`cwd 必须是绝对路径: ${cwd}`);
  const t = nowMs();
  const sessionId = sortableId('ses', t, 0);
  const db = new DatabaseSync(opencodeDbPath());
  try {
    ensureMinimalSchema(db);
    let projectId = 'global';
    try {
      const hit = db.prepare('SELECT id FROM project WHERE worktree = ?').get(cwd) as { id: string } | undefined;
      if (hit?.id) projectId = hit.id;
    } catch { /* keep global */ }
    // 列交集写入：opencode 升级可能给 session 表加列，硬编码全列 INSERT 会直接炸；
    // 只写我们关心的列（其余落表默认，与 TUI 原生建行的 NULL 形态一致）。
    const desired: Record<string, unknown> = {
      id: sessionId,
      project_id: projectId,
      slug: slugFromCwd(cwd),
      directory: cwd,
      title: `Imported - ${isoTimestamp(t)}`,
      version: latestSessionVersion(db),
      time_created: t,
      time_updated: t,
      agent: 'build',
      model: JSON.stringify({ id: 'gpt-5.6-luna', providerID: 'opencode-go', variant: 'high' }),
    };
    const existing = new Set(
      (db.prepare('PRAGMA table_info(session)').all() as { name: string }[]).map((c) => c.name),
    );
    const cols = Object.keys(desired).filter((c) => existing.has(c));
    db.prepare(
      `INSERT INTO session (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    ).run(...cols.map((c) => desired[c] as string));
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
  return { provider: 'opencode', sessionId, filePath: opencodeDbPath(), cwd };
}

type OpencodeModelInfo = { providerID?: string; modelID?: string; variant?: string };

function defaultModel(provider?: string): OpencodeModelInfo {
  switch (provider) {
    case 'claude': return { providerID: 'anthropic', modelID: 'claude-sonnet-4-20250514', variant: 'high' };
    case 'codex': return { providerID: 'openai', modelID: 'o4-mini', variant: 'high' };
    case 'kimi': return { providerID: 'moonshot', modelID: 'k2.7-coding', variant: 'high' };
    case 'pi': return { providerID: 'pi', modelID: 'pi', variant: 'high' };
    case 'opencode': return { providerID: 'openrouter', modelID: 'stealth/ox-alpha', variant: 'high' };
    default: return { providerID: 'opencode-go', modelID: 'gpt-5.6-luna', variant: 'high' };
  }
}

function buildUserMessageData(opts: { time: number; parentId?: string; model?: OpencodeModelInfo }): string {
  const model = opts.model ?? defaultModel();
  const data: Record<string, unknown> = {
    role: 'user',
    time: { created: opts.time },
    agent: 'build',
    model: { providerID: model.providerID ?? 'opencode-go', modelID: model.modelID ?? 'gpt-5.6-luna', variant: model.variant ?? 'high' },
    summary: { diffs: [] },
  };
  if (opts.parentId) data.parentID = opts.parentId;
  return JSON.stringify(data);
}

function buildAssistantMessageData(opts: { time: number; completedTime: number; parentId?: string; cwd: string; model?: OpencodeModelInfo; hasToolEvents: boolean; usage?: TokenUsage }): string {
  const model = opts.model ?? defaultModel();
  const input = opts.usage?.inputTokens ?? 0;
  const output = opts.usage?.outputTokens ?? 0;
  const data: Record<string, unknown> = {
    role: 'assistant',
    mode: 'build',
    agent: 'build',
    variant: 'high',
    path: { cwd: opts.cwd, root: '/' },
    cost: 0,
    tokens: { total: input + output, input, output, reasoning: 0, cache: { write: 0, read: 0 } },
    modelID: model.modelID ?? 'gpt-5.6-luna',
    providerID: model.providerID ?? 'opencode-go',
    time: { created: opts.time, completed: opts.completedTime },
    finish: opts.hasToolEvents ? 'tool-calls' : 'stop',
  };
  if (opts.parentId) (data as Record<string, unknown>).parentID = opts.parentId;
  return JSON.stringify(data);
}

/** attachment → opencode file part data（claude image / 外部 url 都能落）；非附件返回 null */
function buildFilePartData(ev: ProcessEvent): string | null {
  const a = ev.attachment;
  if (!a) return null;
  const mime = a.mediaType ?? 'application/octet-stream';
  const url = a.data ? `data:${mime};base64,${a.data}` : a.url ? a.url : null;
  if (!url) return null;
  const filename = a.filename ?? (a.kind === 'file' ? 'attachment' : 'image');
  const part: Record<string, unknown> = { type: 'file', mime, url };
  if (filename) part.filename = filename;
  return JSON.stringify(part);
}

function buildTextPartData(text: string, time: number): string {
  return JSON.stringify({ type: 'text', text, time: { start: time, end: time + 1 } });
}

function buildReasoningPartData(text: string, time: number): string {
  return JSON.stringify({ type: 'reasoning', text, time: { start: time, end: time + 1 } });
}

function buildStepStartPartData(): string {
  return JSON.stringify({ type: 'step-start' });
}

function buildStepFinishPartData(reason: string): string {
  return JSON.stringify({ type: 'step-finish', reason, tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { write: 0, read: 0 } }, cost: 0 });
}

function buildToolPartData(ev: ProcessEvent, fallbackCallId: string, time: number): string {
  // metadata 是 v1.18+ ToolStateCompleted 必填键（Record，可空对象），缺了整个 GET messages 会被 schema 校验拒掉
  const state: Record<string, unknown> = { status: 'completed', title: ev.name ?? 'tool', metadata: {}, time: { start: time, end: time + 1 } };
  if (ev.kind === 'tool_call') state.input = ev.input ?? {};
  if (ev.kind === 'tool_result') state.output = ev.detail ?? ev.summary ?? '';
  return JSON.stringify({ type: 'tool', callID: ev.callId || fallbackCallId, tool: ev.kind === 'tool_call' ? ev.name : 'tool', state });
}

export async function importTurnsToOpencode(
  turns: UnifiedTurn[],
  cwd: string,
  into?: SessionRef,
  opts?: ImportTurnsOpts,
): Promise<SessionRef> {
  if (!path.isAbsolute(cwd)) throw new Error(`cwd 必须是绝对路径: ${cwd}`);
  const ref = into ?? (await createEmptyOpencodeSession(cwd));
  const db = new DatabaseSync(opencodeDbPath());
  try {
    ensureMinimalSchema(db); // into 指向的库若被清库/重装，兜底建表
    db.exec('BEGIN');
    try {
      // replace 语义 = 清空重建：DELETE 先于写入执行，baseline 归零后对账「重建后总数 == turns 总数」；
      // append 语义 = baseline + 期望增量 == after。两种模式共用同一断言。
      const baseline = opts?.replace
        ? { user: 0, assistant: 0, reasoning: 0, tool: 0, text: 0 }
        : snapshotOpencodeCounts(db, ref.sessionId);
      await writeOpencodeTurns(db, ref, turns, cwd, into, opts);
      assertOpencodeWrite(baseline, snapshotOpencodeCounts(db, ref.sessionId), turns);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw error;
    }
    return ref;
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

type OpencodeCounts = { user: number; assistant: number; reasoning: number; tool: number; text: number };

/** 当前 session 的 message/part 计数快照（事务内对账用） */
function snapshotOpencodeCounts(db: DatabaseSync, sessionId: string): OpencodeCounts {
  const counts: OpencodeCounts = { user: 0, assistant: 0, reasoning: 0, tool: 0, text: 0 };
  const messages = db.prepare('SELECT data FROM message WHERE session_id = ?').all(sessionId) as { data: string }[];
  for (const row of messages) {
    try {
      const d = JSON.parse(row.data) as { role?: string };
      if (d.role === 'user') counts.user += 1;
      else if (d.role === 'assistant') counts.assistant += 1;
    } catch { /* ignore */ }
  }
  const parts = db.prepare('SELECT data FROM part WHERE session_id = ?').all(sessionId) as { data: string }[];
  for (const row of parts) {
    try {
      const d = JSON.parse(row.data) as { type?: string };
      if (d.type === 'reasoning') counts.reasoning += 1;
      else if (d.type === 'tool') counts.tool += 1;
      else if (d.type === 'text') counts.text += 1;
    } catch { /* ignore */ }
  }
  return counts;
}

/** 事务内对账：写出行数必须等于 baseline + 输入 turns 的期望增量，不一致抛错（调用方 ROLLBACK） */
function assertOpencodeWrite(before: OpencodeCounts, after: OpencodeCounts, turns: UnifiedTurn[]): void {
  const assistant = turns.filter((t) => t.role === 'assistant');
  const hasText = (t: UnifiedTurn) => t.text.trim().length > 0;
  const delta: OpencodeCounts = {
    user: turns.filter((t) => t.role === 'user').length,
    assistant: assistant.reduce((n, t) => {
      const hasTool = (t.events ?? []).some((e) => e.kind === 'tool_call');
      return n + (hasTool && hasText(t) ? 2 : 1);
    }, 0),
    reasoning: turns.reduce((n, t) => n + (t.events ?? []).filter((e) => e.kind === 'thinking').length, 0),
    // 与 writeOpencodeTurns 的写入规则同源：tool_call 每个一条 tool part；
    // tool_result 若配对到先前的 call 则 UPDATE 原 part 不增行，否则单独成 part
    tool: turns.reduce((n, t) => {
      let count = 0;
      const pending = new Set<string>();
      for (const ev of t.events ?? []) {
        if (ev.kind === 'tool_call') {
          count += 1;
          if (ev.callId) pending.add(ev.callId);
        } else if (ev.kind === 'tool_result') {
          if (ev.callId && pending.has(ev.callId)) pending.delete(ev.callId);
          else count += 1;
        }
      }
      return n + count;
    }, 0),
    text: deltaTextParts(turns),
  };
  for (const k of Object.keys(delta) as (keyof OpencodeCounts)[]) {
    const actual = after[k] - before[k];
    if (actual !== delta[k]) {
      throw new Error(`[opencode] 事务内对账失败: ${k} 期望增量 ${delta[k]} 实得 ${actual}`);
    }
  }
}

/** text part 增量：每个 user 一条；assistant 有文本则一条（tool 路径与纯文本路径各计一次） */
function deltaTextParts(turns: UnifiedTurn[]): number {
  let n = 0;
  for (const t of turns) {
    if (t.role === 'user') n += 1;
    else if (hasAssistantText(t)) n += 1;
  }
  return n;
}

function hasAssistantText(t: UnifiedTurn): boolean {
  return t.role === 'assistant' && t.text.trim().length > 0;
}

/** 原 importTurnsToOpencode 的语句序列（在调用方的 BEGIN/COMMIT 内执行） */
async function writeOpencodeTurns(
  db: DatabaseSync,
  ref: SessionRef,
  turns: UnifiedTurn[],
  cwd: string,
  into: SessionRef | undefined,
  opts?: ImportTurnsOpts,
): Promise<void> {
  {
    if (opts?.replace) {
      db.prepare('DELETE FROM part WHERE session_id = ?').run(ref.sessionId);
      db.prepare('DELETE FROM message WHERE session_id = ?').run(ref.sessionId);
    }
    let lastUserMessageId = '';
    let userIndex = 0;
    const existingUserIds: string[] = [];
    if (into && !opts?.replace) {
      const rows = db.prepare('SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, id').all(ref.sessionId) as { id: string; data: string }[];
      for (const r of rows) {
        try { if ((JSON.parse(r.data) as { role?: string }).role === 'user') existingUserIds.push(r.id); } catch { /* ignore */ }
      }
    }
    let lastMessageTime = 0;
    let idSeq = 0;
    const nextId = (prefix: string, time: number) => sortableId(prefix, time, idSeq++);

    for (const turn of turns) {
      let messageTime = tsMs(turn.timestamp);
      if (messageTime <= lastMessageTime) messageTime = lastMessageTime + 1;
      lastMessageTime = messageTime;

      if (turn.role === 'user') {
        const msgId = nextId('msg', messageTime);
        userIndex += 1;
        lastUserMessageId = msgId;
        const msgData = buildUserMessageData({ time: messageTime, model: defaultModel(turn.provider) });
        db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)').run(msgId, ref.sessionId, messageTime, messageTime, msgData);
        const partId = nextId('prt', messageTime + 1);
        db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)').run(partId, msgId, ref.sessionId, messageTime + 1, messageTime + 1, buildTextPartData(turn.text, messageTime + 1));
        // user 附带的附件（file part 事件）也一起落盘
        const attachmentParts = (turn.events ?? []).map((ev) => (ev.kind === 'text' ? buildFilePartData(ev) : null)).filter((s): s is string => s !== null);
        for (const [i, partData] of attachmentParts.entries()) {
          const pId = nextId('prt', messageTime + 2 + i);
          db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)').run(pId, msgId, ref.sessionId, messageTime + 2 + i, messageTime + 2 + i, partData);
        }
        continue;
      }

      const parentId = lastUserMessageId || existingUserIds[userIndex - 1];
      const model = defaultModel(turn.provider);
      const hasToolEvents = turn.events?.some((e) => e.kind === 'tool_call') ?? false;
      const hasText = turn.text.trim().length > 0;
      // 附件（图片/文件）事件写为 file part，数据随 attachment 还原
      const attachmentParts = (turn.events ?? [])
        .map((ev) => (ev.kind === 'text' ? buildFilePartData(ev) : null))
        .filter((s): s is string => s !== null);

      const insertAssistantMessage = (id: string, time: number, completedTime: number, toolFinish: boolean) => {
        const msgData = buildAssistantMessageData({ time, completedTime, parentId, cwd, model, hasToolEvents: toolFinish, usage: turn.usage });
        db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)').run(id, ref.sessionId, time, time, msgData);
      };

      if (hasToolEvents) {
        const toolMsgId = nextId('msg', messageTime);
        const toolCompletedTime = messageTime + (turn.events?.length ?? 0) * 100 + 500;
        insertAssistantMessage(toolMsgId, messageTime, toolCompletedTime, true);
        let partTime = messageTime;
        const addPart = (data: string) => {
          partTime += 1;
          const partId = nextId('prt', partTime);
          db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)').run(partId, toolMsgId, ref.sessionId, partTime, partTime, data);
        };
        addPart(buildStepStartPartData());
        for (const partData of attachmentParts) addPart(partData);
        const pendingTools = new Map<string, { partId: string; callId: string }>();
        for (const ev of turn.events ?? []) {
          if (ev.kind === 'thinking') {
            addPart(buildReasoningPartData(ev.detail ?? ev.summary ?? '', partTime + 1));
          } else if (ev.kind === 'tool_call') {
            partTime += 1;
            const partId = nextId('prt', partTime);
            const callId = ev.callId || nextId('call', partTime);
            db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)').run(partId, toolMsgId, ref.sessionId, partTime, partTime, buildToolPartData(ev, callId, partTime));
            pendingTools.set(callId, { partId, callId });
          } else if (ev.kind === 'tool_result') {
            const callId = ev.callId || nextId('call', partTime);
            const pending = pendingTools.get(callId);
            if (pending) {
              const old = db.prepare('SELECT data FROM part WHERE id = ?').get(pending.partId) as { data: string } | undefined;
              if (old) {
                const parsed = JSON.parse(old.data);
                parsed.state ??= {};
                parsed.state.output = ev.detail ?? ev.summary ?? '';
                parsed.state.status = 'completed';
                db.prepare('UPDATE part SET data = ? WHERE id = ?').run(JSON.stringify(parsed), pending.partId);
              }
              pendingTools.delete(callId);
            } else {
              addPart(buildToolPartData(ev, callId, partTime + 1));
            }
          }
        }
        addPart(buildStepFinishPartData('tool-calls'));
        if (hasText) {
          const textMsgTime = partTime + 1;
          const textMsgId = nextId('msg', textMsgTime);
          lastMessageTime = textMsgTime;
          const textCompletedTime = textMsgTime + 500;
          insertAssistantMessage(textMsgId, textMsgTime, textCompletedTime, false);
          let textPartTime = textMsgTime;
          const addTextPart = (data: string) => {
            textPartTime += 1;
            const partId = nextId('prt', textPartTime);
            db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)').run(partId, textMsgId, ref.sessionId, textPartTime, textPartTime, data);
          };
          addTextPart(buildStepStartPartData());
          addTextPart(buildTextPartData(turn.text, textPartTime + 1));
          addTextPart(buildStepFinishPartData('stop'));
        }
      } else {
        const msgId = nextId('msg', messageTime);
        const completedTime = messageTime + (turn.events?.length ?? 0) * 100 + 500;
        insertAssistantMessage(msgId, messageTime, completedTime, false);
        let partTime = messageTime;
        const addPart = (data: string) => {
          partTime += 1;
          const partId = nextId('prt', partTime);
          db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)').run(partId, msgId, ref.sessionId, partTime, partTime, data);
        };
        addPart(buildStepStartPartData());
        for (const ev of turn.events ?? []) {
          if (ev.kind === 'thinking') addPart(buildReasoningPartData(ev.detail ?? ev.summary ?? '', partTime + 1));
        }
        for (const partData of attachmentParts) addPart(partData);
        if (hasText) addPart(buildTextPartData(turn.text, partTime + 1));
        addPart(buildStepFinishPartData('stop'));
      }
    }
    db.prepare('UPDATE session SET time_updated = ? WHERE id = ?').run(nowMs(), ref.sessionId);
  }
}
