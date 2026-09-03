import assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import {
  createEmptyGrokSession,
  findLatestGrokSession,
  importTurnsToGrok,
  listGrokSessions,
} from '../src/providers/grok/build.js';
import { dedupeCallEvents, mergeConsecutiveAssistant } from '../src/core/rich.js';
import type { UnifiedTurn } from '../src/core/types.js';
import { parseGrokSession } from '../src/providers/grok/parse.js';
import { grokAdapter } from '../src/providers/grok/index.js';
import { listAdapters } from '../src/providers/registry.js';

let tmpDir: string;

function cryptoRandom(): string {
  return Math.random().toString(36).slice(2);
}

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'tongbu-grok-'));
});

after(() => {
  // 临时目录由 OS 清理
});

const cwd = '/tmp/grok-test-cwd';

function makeTurns(): Array<{
  role: 'user' | 'assistant';
  text: string;
  timestamp: string;
  provider?: string;
  events?: Array<{
    kind: 'thinking' | 'tool_call' | 'tool_result';
    summary: string;
    detail?: string;
    timestamp: string;
    provider: string;
    name?: string;
    callId?: string;
    input?: unknown;
  }>;
}> {
  return [
    { role: 'user', text: '记住数字 42', timestamp: '2026-08-23T04:00:00.000Z' },
    {
      role: 'assistant',
      text: '好',
      timestamp: '2026-08-23T04:00:01.000Z',
      provider: 'claude',
      events: [
        {
          kind: 'thinking',
          summary: '让我想想',
          detail: '用户要求记住数字',
          timestamp: '2026-08-23T04:00:01.100Z',
          provider: 'claude',
        },
        {
          kind: 'tool_call',
          name: 'Bash',
          callId: 'call_1',
          input: { command: 'echo 42' },
          summary: 'Bash: echo 42',
          timestamp: '2026-08-23T04:00:01.200Z',
          provider: 'claude',
        },
        {
          kind: 'tool_result',
          callId: 'call_1',
          detail: '42',
          summary: '42',
          timestamp: '2026-08-23T04:00:01.300Z',
          provider: 'claude',
        },
      ],
    },
  ];
}

test('importTurns：重放重复 callId 输入经 dedupeCallEvents 收敛后 round-trip 通过', async () => {
  // 重放让同一调用跨代再现：78 个 tool_call 事件只有 6 个唯一 id。
  // 不收敛时「写回全量、parse 会话级去重」导致校验失败（期望 78 实得 6）
  const events: UnifiedTurn['events'] = [];
  const ts = '2026-08-23T04:00:01.000Z';
  for (let i = 0; i < 78; i++) {
    events.push({ kind: 'tool_call', name: 'bash', callId: `call_${i % 6}`, summary: 'bash', detail: '{}', timestamp: ts, provider: 'grok' });
    events.push({ kind: 'tool_result', callId: `call_${i % 6}`, summary: 'ok', detail: 'ok', timestamp: ts, provider: 'grok' });
  }
  const turns: UnifiedTurn[] = [
    { role: 'user', text: 'q', timestamp: '2026-08-23T04:00:00.000Z' },
    { role: 'assistant', text: 'done', timestamp: ts, events },
  ];
  const deduped = dedupeCallEvents(turns);
  const assistant = deduped.find((t) => t.role === 'assistant')!;
  assert.equal((assistant.events ?? []).filter((e) => e.kind === 'tool_call').length, 6);
  assert.equal((assistant.events ?? []).filter((e) => e.kind === 'tool_result').length, 6);
  const ref = await importTurnsToGrok(deduped, cwd, undefined, undefined, tmpDir);
  const parsed = await parseGrokSession(ref);
  assert.equal(parsed.at(-1)?.text, 'done');
  assert.equal((parsed.at(-1)?.events ?? []).filter((e) => e.kind === 'tool_call').length, 6);
});

test('importTurns：连续 assistant 轮导入前合并（grok 无连续 assistant 概念）', async () => {
  // 不合并时写回三行独立 assistant，parse 的 ensureAssistant 会把后两轮并回第一轮，
  // round-trip turn 数不对称（真实案例：期望 8 实得 6）
  const ts = '2026-08-23T04:00:01.000Z';
  const turns: UnifiedTurn[] = [
    { role: 'user', text: 'q', timestamp: '2026-08-23T04:00:00.000Z' },
    { role: 'assistant', text: '第一段', timestamp: ts, events: [
      { kind: 'tool_call', name: 'bash', callId: 'call_1', summary: 'bash', detail: '{}', timestamp: ts, provider: 'grok' },
      { kind: 'tool_result', callId: 'call_1', summary: 'ok', detail: 'ok', timestamp: ts, provider: 'grok' },
    ] },
    { role: 'assistant', text: '第二段', timestamp: ts, events: [
      { kind: 'tool_result', callId: 'call_orphan', summary: '孤儿结果', detail: 'x', timestamp: ts, provider: 'grok' },
    ] },
    { role: 'assistant', text: '第三段', timestamp: ts },
  ];
  const ref = await importTurnsToGrok(mergeConsecutiveAssistant(dedupeCallEvents(turns)), cwd, undefined, undefined, tmpDir);
  const parsed = await parseGrokSession(ref);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[1]?.role, 'assistant');
  assert.equal(parsed[1]?.text, '第一段\n\n第二段\n\n第三段');
  assert.equal((parsed[1]?.events ?? []).filter((e) => e.kind === 'tool_call').length, 1);
});

test('parse：user + assistant text', async () => {
  const ref = await createEmptyGrokSession(cwd, tmpDir);
  const ref2 = await importTurnsToGrok(
    [
      { role: 'user', text: 'hello', timestamp: '2026-08-23T04:00:00.000Z' },
      { role: 'assistant', text: 'hi', timestamp: '2026-08-23T04:00:01.000Z' },
    ],
    cwd,
    ref,
    undefined,
    tmpDir,
  );
  const turns = await parseGrokSession(ref2);
  assert.equal(turns.length, 2);
  assert.equal(turns[0]?.role, 'user');
  assert.equal(turns[0]?.text, 'hello');
  assert.equal(turns[1]?.role, 'assistant');
  assert.equal(turns[1]?.text, 'hi');
});

test('parse：assistant thinking + tool', async () => {
  const ref = await importTurnsToGrok(makeTurns() as any, cwd, undefined, undefined, tmpDir);
  const turns = await parseGrokSession(ref);
  assert.equal(turns.length, 2);
  const assistant = turns[1]!;
  assert.equal(assistant.text, '好');
  assert.equal(assistant.events?.length, 3);
  assert.equal(assistant.events?.[0]?.kind, 'thinking');
  assert.equal(assistant.events?.[1]?.kind, 'tool_call');
  assert.equal(assistant.events?.[1]?.callId, 'call_1');
  assert.equal(assistant.events?.[2]?.kind, 'tool_result');
});

test('importTurns replace：重写后只有新历史', async () => {
  const ref = await importTurnsToGrok(
    [{ role: 'user', text: 'old', timestamp: '2026-08-23T04:00:00.000Z' }],
    cwd,
    undefined,
    undefined,
    tmpDir,
  );
  const ref2 = await importTurnsToGrok(
    [{ role: 'user', text: 'new', timestamp: '2026-08-23T04:01:00.000Z' }],
    cwd,
    ref,
    { replace: true },
    tmpDir,
  );
  const turns = await parseGrokSession(ref2);
  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.text, 'new');
});

test('findLatestGrokSession / listGrokSessions 按 cwd 过滤', async () => {
  await createEmptyGrokSession('/tmp/grok-a', tmpDir);
  await createEmptyGrokSession('/tmp/grok-a', tmpDir);
  await createEmptyGrokSession('/tmp/grok-b', tmpDir);

  const all = await listGrokSessions('/tmp/grok-a', tmpDir);
  assert.equal(all.length, 2);
  assert.ok(all.every((x) => x.ref.cwd === '/tmp/grok-a'));

  const latest = await findLatestGrokSession('/tmp/grok-a', tmpDir);
  assert.ok(latest);
  assert.equal(latest!.ref.cwd, '/tmp/grok-a');
});

test('parse：真实形态——注入包装剥离 + 行内重复 tool_call 去重', async () => {
  const { writeFile, mkdir } = await import('node:fs/promises');
  const dir = join(tmpDir, 'raw-form');
  await mkdir(dir, { recursive: true });
  const chatPath = join(dir, 'chat_history.jsonl');
  const lines = [
    JSON.stringify({ type: 'system', content: 'You are Grok released by xAI.' }),
    JSON.stringify({
      type: 'user',
      content: [
        {
          type: 'text',
          text: "<user_info>\nOS Version: macos\n</user_info>\n\n<rules>\nsome rules\n</rules>\n\n<user_query>\n记住数字 100\n</user_query>",
        },
      ],
    }),
    JSON.stringify({
      type: 'reasoning',
      id: 'rs_1',
      summary: [{ type: 'summary_text', text: '思考：记住 100' }],
      status: 'completed',
    }),
    JSON.stringify({
      type: 'assistant',
      content: '',
      tool_calls: [
        { id: 'call-1', name: 'read_file', arguments: '{"target_file":"a.txt"}' },
        // Grok CLI 会重复登记同一调用，第二次 arguments 是占位垃圾
        { id: 'call-1', name: 'read_file', arguments: '{"input":"read_file"}' },
        { id: 'call-2', name: 'list_dir', arguments: '{"target_directory":"."}' },
      ],
    }),
    JSON.stringify({ type: 'tool_result', tool_call_id: 'call-1', content: 'file body' }),
    JSON.stringify({ type: 'tool_result', tool_call_id: 'call-2', content: 'a.txt' }),
    JSON.stringify({ type: 'assistant', content: '已记住 100。', model_id: 'grok-4.6' }),
  ];
  await writeFile(chatPath, lines.join('\n') + '\n', 'utf8');

  const turns = await parseGrokSession({ provider: 'grok', sessionId: 'raw', filePath: chatPath, cwd });
  assert.equal(turns.length, 2);
  assert.equal(turns[0]?.text, '记住数字 100'); // 注入包装被剥掉
  const calls = (turns[1]?.events ?? []).filter((e) => e.kind === 'tool_call');
  assert.equal(calls.length, 2); // 重复的 call-1 只留首个（真实参数）
  assert.deepEqual(calls[0]?.input, { target_file: 'a.txt' });
  const results = (turns[1]?.events ?? []).filter((e) => e.kind === 'tool_result');
  assert.equal(results.length, 2);
});

test('listGrokSessions：无 summary.json 的旧会话用 mtime 兜底排序', async () => {
  const { writeFile, mkdir, utimes } = await import('node:fs/promises');
  const root = join(tmpDir, 'legacy-root');
  const dir = join(root, encodeURIComponent(cwd));
  for (const [id, mtimeMs] of [
    ['11111111-1111-1111-1111-111111111111', 5_000],
    ['22222222-2222-2222-2222-222222222222', 9_000],
  ] as const) {
    await mkdir(join(dir, id), { recursive: true });
    await writeFile(join(dir, id, 'chat_history.jsonl'), '{"type":"system","content":"x"}\n');
    await utimes(join(dir, id, 'chat_history.jsonl'), new Date(mtimeMs), new Date(mtimeMs));
  }
  const { listGrokSessions } = await import('../src/providers/grok/build.js');
  const all = await listGrokSessions(cwd, root);
  assert.equal(all.length, 2);
  assert.equal(all[0]?.ref.sessionId, '22222222-2222-2222-2222-222222222222'); // mtime 新的在前
  assert.equal(all[0]?.updatedAt, 9_000);
});

test('parse：summary.json created_at 作为会话时间锚点（不再伪造 now）', async () => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const dir = join(tmpDir, `anchor-${cryptoRandom()}`);
  await mkdir(dir, { recursive: true });
  const chatPath = join(dir, 'chat_history.jsonl');
  const created = '2026-08-01T00:00:00.000Z';
  await writeFile(join(dir, 'summary.json'), JSON.stringify({ created_at: created }), 'utf8');
  await writeFile(
    chatPath,
    [
      JSON.stringify({ type: 'system', content: 'x' }),
      JSON.stringify({ type: 'user', content: '你好' }),
      JSON.stringify({ type: 'assistant', content: '收到' }),
    ].join('\n') + '\n',
    'utf8',
  );
  const turns = await parseGrokSession({ provider: 'grok', sessionId: 'anchor', filePath: chatPath, cwd });
  assert.equal(turns.length, 2);
  const t0 = Date.parse(turns[0]!.timestamp);
  const base = Date.parse(created);
  assert.ok(t0 >= base, `首 turn 时间应 ≥ created_at（${new Date(t0).toISOString()} vs ${created}）`);
  assert.ok(t0 - base < 5_000, `应落在锚点后毫秒级（实际差 ${t0 - base}ms）`);
  const t1 = Date.parse(turns[1]!.timestamp);
  assert.ok(t1 > t0, '时间戳应随行单调递增');
});

test('parse：无 summary.json 时回退本地时间（旧行为不回归）', async () => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const dir = join(tmpDir, 'no-anchor');
  await mkdir(dir, { recursive: true });
  const chatPath = join(dir, 'chat_history.jsonl');
  await writeFile(chatPath, JSON.stringify({ type: 'user', content: 'hi' }) + '\n', 'utf8');
  const before = Date.now();
  const turns = await parseGrokSession({ provider: 'grok', sessionId: 'no-anchor', filePath: chatPath, cwd });
  const after = Date.now();
  const t = Date.parse(turns[0]!.timestamp);
  assert.ok(t >= before && t <= after, `回退应为本地 now（${new Date(t).toISOString()}）`);
});

test('registry 注册 Grok', () => {
  const ids = listAdapters().map((a) => a.id);
  assert.ok(ids.includes('grok'));
});

test('grokAdapter.detect 返回布尔值', async () => {
  const available = await grokAdapter.detect();
  assert.equal(typeof available, 'boolean');
});
