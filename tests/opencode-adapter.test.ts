import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import {
  findLatestOpencodeSession,
  importTurnsToOpencode,
  listOpencodeSessions,
} from '../src/providers/opencode/build.js';
import { parseOpencodeSession } from '../src/providers/opencode/parse.js';
import { opencodeAdapter } from '../src/providers/opencode/index.js';
import { listAdapters } from '../src/providers/registry.js';

let tmpDir: string;
let testDb: string;

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'tongbu-opencode-'));
  testDb = join(tmpDir, 'opencode.db');
  process.env.TONG_OPENCODE_DB = testDb;
});

after(() => {
  delete process.env.TONG_OPENCODE_DB;
});

function initSchema(): void {
  const db = new DatabaseSync(testDb);
  db.exec(`
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
  db.close();
}

function seedSession(sessionId: string, cwd: string, title: string, updatedAt: number): void {
  const db = new DatabaseSync(testDb);
  db.prepare(
    `INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated, agent, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write)
     VALUES (?, 'global', ?, ?, ?, '1.18.21', ?, ?, 'build', 0, 0, 0, 0, 0, 0)`,
  ).run(sessionId, cwd.replace(/[^a-zA-Z0-9]/g, ''), cwd, title, updatedAt, updatedAt);
  db.close();
}

function seedMessage(sessionId: string, msgId: string, role: string, time: number, parentId?: string): void {
  const db = new DatabaseSync(testDb);
  const data: Record<string, unknown> = {
    role,
    time: { created: time },
    agent: 'build',
    model: { providerID: 'opencode-go', modelID: 'gpt-5.6-luna' },
    summary: { diffs: [] },
    id: msgId,
    sessionID: sessionId,
  };
  if (parentId) data.parentID = parentId;
  db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)').run(
    msgId,
    sessionId,
    time,
    time,
    JSON.stringify(data),
  );
  db.close();
}

function seedPart(sessionId: string, messageId: string, data: Record<string, unknown>, time: number): void {
  const db = new DatabaseSync(testDb);
  db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)').run(
    `prt_${messageId}_${Math.random().toString(36).slice(2, 10)}`,
    messageId,
    sessionId,
    time,
    time,
    JSON.stringify(data),
  );
  db.close();
}

test('parse：user + assistant text', async () => {
  initSchema();
  const sessionId = 'ses_parse_text';
  const cwd = '/tmp/opencode-parse-text';
  seedSession(sessionId, cwd, 'text session', 1000);

  const uMsg = 'msg_u1';
  seedMessage(sessionId, uMsg, 'user', 1000);
  seedPart(sessionId, uMsg, { type: 'text', text: 'hello' }, 1000);

  const aMsg = 'msg_a1';
  seedMessage(sessionId, aMsg, 'assistant', 1001, uMsg);
  seedPart(sessionId, aMsg, { type: 'text', text: 'hi there' }, 1001);

  const turns = await parseOpencodeSession({ provider: 'opencode', sessionId, filePath: testDb, cwd });
  assert.equal(turns.length, 2);
  assert.equal(turns[0]?.role, 'user');
  assert.equal(turns[0]?.text, 'hello');
  assert.equal(turns[1]?.role, 'assistant');
  assert.equal(turns[1]?.text, 'hi there');
});

test('parse：assistant reasoning + tool', async () => {
  initSchema();
  const sessionId = 'ses_parse_rich';
  const cwd = '/tmp/opencode-parse-rich';
  seedSession(sessionId, cwd, 'rich session', 2000);

  const uMsg = 'msg_u2';
  seedMessage(sessionId, uMsg, 'user', 2000);
  seedPart(sessionId, uMsg, { type: 'text', text: 'run a command' }, 2000);

  const aMsg = 'msg_a2';
  seedMessage(sessionId, aMsg, 'assistant', 2001, uMsg);
  seedPart(sessionId, aMsg, { type: 'reasoning', text: 'thinking...' }, 2001);
  seedPart(sessionId, aMsg, {
    type: 'tool',
    callID: 'call_1',
    tool: 'bash',
    state: { status: 'completed', input: { command: 'ls' }, output: 'file.txt' },
  }, 2002);
  seedPart(sessionId, aMsg, { type: 'text', text: 'done' }, 2003);

  const turns = await parseOpencodeSession({ provider: 'opencode', sessionId, filePath: testDb, cwd });
  assert.equal(turns.length, 2);
  const assistant = turns[1]!;
  assert.equal(assistant.text, 'done');
  assert.equal(assistant.events?.length, 3);
  assert.equal(assistant.events?.[0]?.kind, 'thinking');
  assert.equal(assistant.events?.[1]?.kind, 'tool_call');
  assert.equal(assistant.events?.[1]?.callId, 'call_1');
  assert.equal(assistant.events?.[2]?.kind, 'tool_result');
});

test('parse：过滤 system / step-start / step-finish', async () => {
  initSchema();
  const sessionId = 'ses_parse_filter';
  const cwd = '/tmp/opencode-parse-filter';
  seedSession(sessionId, cwd, 'filter session', 3000);

  const uMsg = 'msg_u3';
  seedMessage(sessionId, uMsg, 'user', 3000);
  seedPart(sessionId, uMsg, { type: 'text', text: 'ok' }, 3000);

  const aMsg = 'msg_a3';
  seedMessage(sessionId, aMsg, 'assistant', 3001, uMsg);
  seedPart(sessionId, aMsg, { type: 'step-start' }, 3001);
  seedPart(sessionId, aMsg, { type: 'text', text: 'result' }, 3002);
  seedPart(sessionId, aMsg, { type: 'step-finish', reason: 'end_turn' }, 3003);

  const turns = await parseOpencodeSession({ provider: 'opencode', sessionId, filePath: testDb, cwd });
  assert.equal(turns.length, 2);
  assert.equal(turns[1]?.text, 'result');
  assert.equal(turns[1]?.events?.length ?? 0, 0);
});

test('importTurnsToOpencode：replace 覆盖已有内容时对账按清空重建语义', async () => {
  initSchema();
  const cwd = '/tmp/opencode-replace';
  // 第一遍 append 建内容
  const ref = await importTurnsToOpencode(
    [
      { role: 'user', text: '第一轮', timestamp: '2026-08-22T12:00:00.000Z' },
      { role: 'assistant', text: '回复', timestamp: '2026-08-22T12:00:01.000Z' },
    ],
    cwd,
  );
  // 第二遍 replace 重写（rewrite_only 路径：目标已含全部内容仍强制重写修格式）
  await importTurnsToOpencode(
    [
      { role: 'user', text: '第一轮', timestamp: '2026-08-22T12:00:00.000Z' },
      { role: 'assistant', text: '回复', timestamp: '2026-08-22T12:00:01.000Z' },
      { role: 'user', text: '第二轮', timestamp: '2026-08-22T12:00:02.000Z' },
      { role: 'assistant', text: '好', timestamp: '2026-08-22T12:00:03.000Z' },
    ],
    cwd,
    ref,
    { replace: true },
  );
  const back = await parseOpencodeSession(ref);
  assert.equal(back.length, 4);
  assert.equal(back[0]?.text, '第一轮');
  assert.equal(back[2]?.text, '第二轮');
});

test('tool part state 必须带 metadata（v1.18 GET messages schema 必填）', async () => {
  initSchema();
  const ref = await importTurnsToOpencode(
    [
      { role: 'user', text: '跑个命令', timestamp: '2026-08-30T12:00:00.000Z' },
      {
        role: 'assistant',
        text: '完成',
        timestamp: '2026-08-30T12:00:01.000Z',
        events: [
          {
            kind: 'tool_call',
            name: 'Bash',
            callId: 'call_x1',
            input: { command: 'ls' },
            timestamp: '2026-08-30T12:00:01.000Z',
          },
          {
            kind: 'tool_result',
            callId: 'call_x1',
            detail: 'ok',
            timestamp: '2026-08-30T12:00:02.000Z',
          },
        ],
      },
    ],
    '/tmp/opencode-meta',
  );
  const db = new DatabaseSync(testDb, { readOnly: true });
  const parts = db
    .prepare('SELECT data FROM part WHERE session_id = ? AND data LIKE \'%"type":"tool"%\'')
    .all(ref.sessionId) as { data: string }[];
  db.close();
  assert.equal(parts.length, 1);
  const state = (JSON.parse(parts[0].data) as { state: Record<string, unknown> }).state;
  assert.deepEqual(state.metadata, {});
});

test('findLatestOpencodeSession / listOpencodeSessions 按 cwd 过滤', async () => {
  initSchema();
  seedSession('ses_a', '/tmp/opencode-cwd-a', 'a', 5000);
  seedSession('ses_b', '/tmp/opencode-cwd-b', 'b', 4000);
  seedSession('ses_c', '/tmp/opencode-cwd-a', 'c', 4500);

  const latest = await findLatestOpencodeSession('/tmp/opencode-cwd-a');
  assert.equal(latest?.ref.sessionId, 'ses_a');

  const all = await listOpencodeSessions('/tmp/opencode-cwd-a');
  assert.equal(all.length, 2);
  assert.equal(all[0]?.ref.sessionId, 'ses_a');
  assert.equal(all[1]?.ref.sessionId, 'ses_c');
});

test('importTurnsToOpencode：写入后 parse round-trip', async () => {
  initSchema();
  const cwd = '/tmp/opencode-import';
  const ref = await importTurnsToOpencode(
    [
      { role: 'user', text: '记住数字 42', timestamp: '2026-08-22T12:00:00.000Z' },
      {
        role: 'assistant',
        text: '好',
        timestamp: '2026-08-22T12:00:01.000Z',
        provider: 'opencode',
      },
    ],
    cwd,
  );

  assert.equal(ref.provider, 'opencode');
  assert.ok(ref.sessionId.startsWith('ses_'));

  const back = await parseOpencodeSession(ref);
  assert.equal(back.length, 2);
  assert.equal(back[0]?.text, '记住数字 42');
  assert.equal(back[1]?.text, '好');
});

test('importTurnsToOpencode：assistant message 补全 OpenCode v1 必填字段', async () => {
  initSchema();
  const cwd = '/tmp/opencode-import-schema';
  const ref = await importTurnsToOpencode(
    [
      { role: 'user', text: '调用 Bash 看看', timestamp: '2026-08-22T12:00:00.000Z' },
      {
        role: 'assistant',
        text: '已执行',
        timestamp: '2026-08-22T12:00:01.000Z',
        provider: 'claude',
        events: [
          {
            kind: 'thinking',
            summary: '思考中…',
            detail: '让我想想',
            timestamp: '2026-08-22T12:00:01.100Z',
            provider: 'claude',
          },
          {
            kind: 'tool_call',
            name: 'Bash',
            callId: 'call_1',
            input: { command: 'ls' },
            summary: 'Bash: ls',
            timestamp: '2026-08-22T12:00:01.200Z',
            provider: 'claude',
          },
          {
            kind: 'tool_result',
            callId: 'call_1',
            detail: 'file.txt',
            summary: 'file.txt',
            timestamp: '2026-08-22T12:00:01.300Z',
            provider: 'claude',
          },
        ],
      },
    ],
    cwd,
  );

  const db = new DatabaseSync(testDb);
  try {
    const msgs = db
      .prepare('SELECT data FROM message WHERE session_id = ? ORDER BY time_created')
      .all(ref.sessionId) as { data: string }[];
    // user + tool-calls assistant + final-text assistant
    assert.equal(msgs.length, 3);

    const user = JSON.parse(msgs[0]!.data);
    assert.equal(user.role, 'user');
    assert.equal(user.agent, 'build');
    assert.equal(user.model?.variant, 'high');
    assert.deepEqual(user.summary, { diffs: [] });

    const toolAssistant = JSON.parse(msgs[1]!.data);
    assert.equal(toolAssistant.role, 'assistant');
    assert.equal(toolAssistant.mode, 'build');
    assert.equal(toolAssistant.agent, 'build');
    assert.equal(toolAssistant.variant, 'high');
    assert.deepEqual(toolAssistant.path, { cwd, root: '/' });
    assert.equal(toolAssistant.finish, 'tool-calls');
    assert.equal(toolAssistant.cost, 0);
    assert.ok(toolAssistant.tokens);
    assert.equal(toolAssistant.modelID, 'claude-sonnet-4-20250514');
    assert.equal(toolAssistant.providerID, 'anthropic');
    assert.ok(toolAssistant.time?.created);
    assert.ok(toolAssistant.time?.completed);

    const textAssistant = JSON.parse(msgs[2]!.data);
    assert.equal(textAssistant.role, 'assistant');
    assert.equal(textAssistant.finish, 'stop');
    assert.equal(textAssistant.parentID, toolAssistant.parentID);

    const parts = db
      .prepare('SELECT data FROM part WHERE session_id = ? ORDER BY time_created')
      .all(ref.sessionId) as { data: string }[];
    const types = parts.map((p) => JSON.parse(p.data).type);
    assert.deepEqual(types, [
      'text',
      'step-start',
      'reasoning',
      'tool',
      'step-finish',
      'step-start',
      'text',
      'step-finish',
    ]);

    const toolPart = JSON.parse(parts[3]!.data);
    assert.equal(toolPart.type, 'tool');
    assert.equal(toolPart.tool, 'Bash');
    assert.equal(toolPart.state?.status, 'completed');
    assert.equal(toolPart.state?.title, 'Bash');
    // 原生采样：text/reasoning/tool 均有 time，仅 step-* 无
    assert.ok(toolPart.state?.time?.start);
    const userTextPart = JSON.parse(parts[0]!.data);
    assert.equal(userTextPart.type, 'text');
    assert.ok(userTextPart.time?.start);
  } finally {
    db.close();
  }
});

test('registry 注册 OpenCode', () => {
  const ids = listAdapters().map((a) => a.id);
  assert.ok(ids.includes('opencode'));
});

test('opencodeAdapter.detect 返回布尔值', async () => {
  const available = await opencodeAdapter.detect();
  assert.equal(typeof available, 'boolean');
});

test('parse：file part 升级为 attachment 事件（占位在事件，不进 turn.text）', async () => {
  initSchema();
  const sessionId = 'ses_file_part';
  const cwd = '/tmp/opencode-file';
  seedSession(sessionId, cwd, 'file session', 4000);

  const uMsg = 'msg_f1';
  seedMessage(sessionId, uMsg, 'user', 4000);
  seedPart(sessionId, uMsg, { type: 'text', text: '看看这图' }, 4000);
  seedPart(sessionId, uMsg, { type: 'file', filename: 'x.png', mime: 'image/png', url: 'data:image/png;base64,AAAA' }, 4001);

  const aMsg = 'msg_f2';
  seedMessage(sessionId, aMsg, 'assistant', 4002, uMsg);
  seedPart(sessionId, aMsg, { type: 'text', text: '看到了' }, 4002);

  const turns = await parseOpencodeSession({ provider: 'opencode', sessionId, filePath: testDb, cwd });
  assert.equal(turns.length, 2);
  assert.equal(turns[0]!.text, '看看这图');
  assert.equal(turns[0]!.events?.length, 1);
  assert.equal(turns[0]!.events?.[0]?.kind, 'text');
  assert.equal(turns[0]!.events?.[0]?.summary, '[附件：image/png，约19B x.png]');
  assert.deepEqual(turns[0]!.events?.[0]?.attachment, {
    kind: 'file',
    mediaType: 'image/png',
    url: 'data:image/png;base64,AAAA',
    filename: 'x.png',
  });
  assert.equal(turns[1]!.text, '看到了');
});

test('parse：纯 file part 无文本的 user 消息仍保留（占位在事件，text 为空）', async () => {
  initSchema();
  const sessionId = 'ses_file_only';
  const cwd = '/tmp/opencode-file-only';
  seedSession(sessionId, cwd, 'file only session', 4100);

  const uMsg = 'msg_fo1';
  seedMessage(sessionId, uMsg, 'user', 4100);
  seedPart(sessionId, uMsg, { type: 'file', filename: 'x.png', mime: 'image/png', url: 'data:image/png;base64,QUJD' }, 4100);

  const aMsg = 'msg_fo2';
  seedMessage(sessionId, aMsg, 'assistant', 4101, uMsg);
  seedPart(sessionId, aMsg, { type: 'text', text: '收到了' }, 4101);

  const turns = await parseOpencodeSession({ provider: 'opencode', sessionId, filePath: testDb, cwd });
  assert.equal(turns.length, 2);
  assert.equal(turns[0]!.text, '');
  assert.equal(turns[0]!.events?.[0]?.attachment?.kind, 'file');
});

test('parse：assistant message 读真实 tokens 进 turn.usage', async () => {
  initSchema();
  const sessionId = 'ses_usage';
  const cwd = '/tmp/opencode-usage';
  seedSession(sessionId, cwd, 'usage session', 4200);

  const uMsg = 'msg_u4';
  seedMessage(sessionId, uMsg, 'user', 4200);
  seedPart(sessionId, uMsg, { type: 'text', text: 'hi' }, 4200);

  const aMsg = 'msg_a4';
  seedMessage(sessionId, aMsg, 'assistant', 4201, uMsg);
  const data: Record<string, unknown> = {
    role: 'assistant',
    time: { created: 4201 },
    model: { providerID: 'opencode-go', modelID: 'gpt-5.6-luna' },
    tokens: { total: 900, input: 400, output: 500, reasoning: 0, cache: { write: 0, read: 0 } },
    agent: 'build',
    summary: { diffs: [] },
    id: aMsg,
    sessionID: sessionId,
  };
  const db = new DatabaseSync(testDb);
  db.prepare('UPDATE message SET data = ? WHERE id = ?').run(JSON.stringify(data), aMsg);
  db.close();
  seedPart(sessionId, aMsg, { type: 'text', text: 'hi there' }, 4201);

  const turns = await parseOpencodeSession({ provider: 'opencode', sessionId, filePath: testDb, cwd });
  assert.deepEqual(turns[1]!.usage, { inputTokens: 400, outputTokens: 500 });
});

test('opencode→opencode：attachment 事件写回为 file part，再 parse 回来 attachment 仍在', async () => {
  initSchema();
  const cwd = '/tmp/opencode-attach-rt';
  const ref = await importTurnsToOpencode([
    { role: 'user', text: '看附件', timestamp: '2026-08-22T12:00:00.000Z' },
    {
      role: 'user',
      text: '',
      timestamp: '2026-08-22T12:00:01.000Z',
      events: [
        {
          kind: 'text',
          summary: '[附件：image/png，3B]',
          detail: '[附件：image/png，3B]',
          timestamp: '2026-08-22T12:00:01.000Z',
          provider: 'opencode',
          attachment: { kind: 'file', mediaType: 'image/png', data: 'AAA', filename: 'x.png' },
        },
      ],
    },
    { role: 'assistant', text: '收到了', timestamp: '2026-08-22T12:00:02.000Z' },
  ], cwd);

  const back = await parseOpencodeSession(ref);
  assert.equal(back.length, 3);
  assert.equal(back[1]!.text, '');
  const at = back[1]!.events?.[0]?.attachment;
  assert.equal(at?.kind, 'file');
  assert.equal(at?.mediaType, 'image/png');
  assert.equal(at?.filename, 'x.png');
  // build 把 data 编码成 data URI 过 link：还原成 base64 data
  assert.equal((at?.url as string).split(',')[1], 'AAA');
});

test('importTurnsToOpencode：usage 写入 assistant message data.tokens', async () => {
  initSchema();
  const ref = await importTurnsToOpencode([
    { role: 'user', text: '跑个命令', timestamp: '2026-08-30T12:00:00.000Z' },
    {
      role: 'assistant',
      text: '完成',
      timestamp: '2026-08-30T12:00:01.000Z',
      usage: { inputTokens: 111, outputTokens: 222 },
    },
  ], '/tmp/opencode-usage-write');
  const db = new DatabaseSync(testDb, { readOnly: true });
  const rows = db.prepare('SELECT data FROM message WHERE session_id = ?').all(ref.sessionId) as { data: string }[];
  db.close();
  const assistantRows = rows.filter((r) => (JSON.parse(r.data) as { role?: string }).role === 'assistant');
  assert.equal(assistantRows.length, 1);
  const tokens = (JSON.parse(assistantRows[0]!.data) as { tokens: { input: number; output: number; total: number } }).tokens;
  assert.deepEqual({ input: tokens.input, output: tokens.output, total: tokens.total }, { input: 111, output: 222, total: 333 });
});

test('importTurnsToOpencode：全新空库自举（不依赖 pre-init schema）', async () => {
  // 不复用共享 testDb（带表），用全新空库文件
  const bareDir = mkdtempSync(join(tmpdir(), 'tongbu-opencode-bare-'));
  const bareDb = join(bareDir, 'opencode.db');
  const old = process.env.TONG_OPENCODE_DB;
  process.env.TONG_OPENCODE_DB = bareDb;
  try {
    const ref = await importTurnsToOpencode(
      [
        { role: 'user', text: '你好', timestamp: '2026-08-22T12:00:00.000Z' },
        { role: 'assistant', text: '嗨', timestamp: '2026-08-22T12:00:01.000Z', usage: { inputTokens: 5, outputTokens: 3 } },
      ],
      '/tmp/opencode-bare-cwd',
    );
    assert.ok(ref.sessionId.startsWith('ses_'));
    const back = await parseOpencodeSession(ref);
    assert.equal(back.length, 2);
    assert.equal(back[0]!.text, '你好');
    assert.deepEqual(back[1]!.usage, { inputTokens: 5, outputTokens: 3 });
    // 列表可读
    const all = await listOpencodeSessions('/tmp/opencode-bare-cwd');
    assert.equal(all.length, 1);
  } finally {
    process.env.TONG_OPENCODE_DB = old;
  }
});
