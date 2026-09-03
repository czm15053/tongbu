import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseCodexSession } from '../src/providers/codex/parse.js';
import { codexSessionUsage } from '../src/providers/codex/usage.js';
import { buildCodexLines, importTurnsToCodex, validateRolloutFilename } from '../src/providers/codex/build.js';
import type { SessionRef, UnifiedTurn } from '../src/core/types.js';

async function withTempFile(lines: string[], fn: (ref: SessionRef) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'tongbu-'));
  const filePath = path.join(dir, 'rollout-2026-08-21T01-00-00-u1.jsonl');
  await writeFile(filePath, lines.join('\n') + '\n');
  try {
    await fn({ provider: 'codex', sessionId: 's1', filePath, cwd: '/a/b' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const TS = '2026-08-21T01:00:00.000Z';
const responseItem = (payload: Record<string, unknown>, timestamp = TS) =>
  JSON.stringify({ timestamp, type: 'response_item', payload });
const eventMsg = (payload: Record<string, unknown>, timestamp = TS) =>
  JSON.stringify({ timestamp, type: 'event_msg', payload });
const userContent = (text: string) => [{ type: 'input_text', text }];
const assistantContent = (text: string) => [{ type: 'output_text', text }];

const IDENTITY = { originator: 'codex_cli_rs', source: 'cli', cliVersion: '0.147.0' };
const NOW = new Date('2026-08-21T05:00:00.000Z');

test('parse：过滤内部上下文/完成后 commentary，保最终回复和 reasoning/tools', async () => {
  const lines = [
    responseItem({ type: 'message', role: 'assistant', content: assistantContent('早于首条 user，丢弃') }),
    responseItem({
      type: 'message',
      role: 'user',
      content: userContent('<environment_context>\n<cwd>/a/b</cwd>\n</environment_context>'),
    }),
    responseItem({
      type: 'message',
      role: 'user',
      content: userContent('# AGENTS.md instructions for /a/b\n\n<INSTRUCTIONS>\nBe good\n</INSTRUCTIONS>'),
    }),
    'not json {{{',
    responseItem({ type: 'message', role: 'user', content: userContent('第一问') }, '2026-08-21T01:00:01.000Z'),
    responseItem({ type: 'reasoning', summary: [] }, '2026-08-21T01:00:02.000Z'),
    responseItem(
      { type: 'message', role: 'assistant', phase: 'commentary', content: assistantContent('我先查一下') },
      '2026-08-21T01:00:03.000Z',
    ),
    responseItem(
      { type: 'function_call', name: 'shell_command', arguments: '{}', call_id: 'c1' },
      '2026-08-21T01:00:04.000Z',
    ),
    responseItem({ type: 'function_call_output', call_id: 'c1', output: 'ok' }, '2026-08-21T01:00:05.000Z'),
    responseItem(
      { type: 'message', role: 'assistant', content: assistantContent('中间段') },
      '2026-08-21T01:00:06.000Z',
    ),
    responseItem(
      { type: 'message', role: 'assistant', phase: 'final_answer', content: assistantContent('最终回复') },
      '2026-08-21T01:00:07.000Z',
    ),
  ];
  await withTempFile(lines, async (ref) => {
    const turns = await parseCodexSession(ref);
    assert.equal(turns.length, 2);
    assert.equal(turns[0].text, '第一问');
    assert.equal(turns[1].text, '最终回复');
    assert.equal(turns[1].timestamp, '2026-08-21T01:00:07.000Z');
    assert.deepEqual(
      turns[1].events?.map((e) => ({ kind: e.kind, name: e.name, callId: e.callId, detail: e.detail })),
      [
        { kind: 'tool_call', name: 'shell_command', callId: 'c1', detail: '{}' },
        { kind: 'tool_result', name: undefined, callId: 'c1', detail: 'ok' },
      ],
    );
  });
});

test('parse：剥离 ## My request for Codex: 包裹，跳过 encrypted_content', async () => {
  const lines = [
    responseItem({
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: '附件说明\n\n## My request for Codex:\n<image 1>\n</image>\n真实问题' },
      ],
    }),
    responseItem({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'encrypted_content', text: '密文丢弃' }, { type: 'output_text', text: '答' }],
    }),
  ];
  await withTempFile(lines, async (ref) => {
    const turns = await parseCodexSession(ref);
    assert.equal(turns[0].text, '真实问题');
    assert.equal(turns[1].text, '答');
  });
});

test('parse：turn 中断时保留最后一条 commentary，避免交接丢回复', async () => {
  const lines = [
    responseItem({ type: 'message', role: 'user', content: userContent('随便调用几个工具') }, '2026-08-21T01:00:01.000Z'),
    responseItem(
      { type: 'message', role: 'assistant', phase: 'commentary', content: assistantContent('我先探查') },
      '2026-08-21T01:00:02.000Z',
    ),
    responseItem(
      { type: 'message', role: 'assistant', phase: 'commentary', content: assistantContent('探查结果：只有 demo') },
      '2026-08-21T01:00:03.000Z',
    ),
  ];
  await withTempFile(lines, async (ref) => {
    const turns = await parseCodexSession(ref);
    assert.deepEqual(turns, [
      { role: 'user', text: '随便调用几个工具', timestamp: '2026-08-21T01:00:01.000Z' },
      { role: 'assistant', text: '探查结果：只有 demo', timestamp: '2026-08-21T01:00:03.000Z', provider: 'codex' },
    ]);
  });
});

test('parse：无 response_item message 时回退 event_msg 旧版 wire', async () => {
  const lines = [
    eventMsg({ type: 'user_message', message: '旧版问题' }, '2026-08-21T02:00:00.000Z'),
    eventMsg({ type: 'agent_message', message: '旧版中间' }, '2026-08-21T02:00:01.000Z'),
    eventMsg({ type: 'agent_message', message: '旧版最终' }, '2026-08-21T02:00:02.000Z'),
    eventMsg({ type: 'task_complete', turn_id: 't1' }),
  ];
  await withTempFile(lines, async (ref) => {
    const turns = await parseCodexSession(ref);
    assert.deepEqual(turns, [
      { role: 'user', text: '旧版问题', timestamp: '2026-08-21T02:00:00.000Z' },
      { role: 'assistant', text: '旧版最终', timestamp: '2026-08-21T02:00:02.000Z', provider: 'codex' },
    ]);
  });
});

test('buildCodexLines：session_meta 首行、turn_id 配对、wire 结构完整', () => {
  const turns: UnifiedTurn[] = [
    { role: 'user', text: '问题一', timestamp: '2026-08-21T02:00:00.000Z' },
    { role: 'assistant', text: '回答一', timestamp: '2026-08-21T02:00:01.000Z' },
    { role: 'user', text: '问题二', timestamp: '2026-08-21T02:00:02.000Z' },
    { role: 'assistant', text: '回答二', timestamp: '2026-08-21T02:00:03.000Z' },
  ];
  const lines = buildCodexLines(turns, 'new-id', '/a/b', 'openai', IDENTITY, NOW).map((l) => JSON.parse(l));

  const meta = lines[0];
  assert.equal(meta.type, 'session_meta');
  assert.deepEqual(
    { id: meta.payload.id, session_id: meta.payload.session_id, cwd: meta.payload.cwd, mp: meta.payload.model_provider, cv: meta.payload.cli_version },
    { id: 'new-id', session_id: 'new-id', cwd: '/a/b', mp: 'openai', cv: '0.147.0' },
  );
  for (const r of lines) assert.equal(r.timestamp, NOW.toISOString());

  const types = lines.slice(1).map((r) => (r.type === 'turn_context' ? 'turn_context' : `${r.type}:${r.payload.type}`));
  assert.deepEqual(types, [
    'event_msg:task_started',
    'turn_context',
    'event_msg:user_message',
    'response_item:message',
    'event_msg:agent_message',
    'response_item:message',
    'event_msg:token_count',
    'event_msg:task_complete',
    'event_msg:task_started',
    'turn_context',
    'event_msg:user_message',
    'response_item:message',
    'event_msg:agent_message',
    'response_item:message',
    'event_msg:token_count',
    'event_msg:task_complete',
  ]);

  const started = lines.filter((r) => r.payload.type === 'task_started');
  const completed = lines.filter((r) => r.payload.type === 'task_complete');
  assert.equal(started.length, 2);
  assert.deepEqual(completed.map((r) => r.payload.turn_id), started.map((r) => r.payload.turn_id));
  assert.equal(completed[1].payload.started_at, Math.floor(Date.parse('2026-08-21T02:00:02.000Z') / 1000));
  assert.equal(completed[1].payload.completed_at, Math.floor(Date.parse('2026-08-21T02:00:03.000Z') / 1000));
  assert.equal(completed[1].payload.last_agent_message, null);

  const userItem = lines.find((r) => r.type === 'response_item' && r.payload.role === 'user');
  assert.deepEqual(userItem.payload.content, [{ type: 'input_text', text: '问题一' }]);
  const agentItem = lines.find((r) => r.type === 'response_item' && r.payload.role === 'assistant');
  assert.deepEqual(agentItem.payload.content, [{ type: 'output_text', text: '回答一' }]);
});

test('buildCodexLines：无 user 报错；空文本与孤立 assistant 跳过', () => {
  assert.throws(
    () => buildCodexLines([{ role: 'assistant', text: '只有回复', timestamp: '' }], 'x', '/a', 'openai', IDENTITY, NOW),
    /没有可迁移的用户消息/,
  );
  const lines = buildCodexLines(
    [
      { role: 'user', text: '问', timestamp: '2026-08-21T02:00:00.000Z' },
      { role: 'assistant', text: '  ', timestamp: '' },
    ],
    'x',
    '/a',
    'openai',
    IDENTITY,
    NOW,
  );
  assert.ok(!lines.some((l) => JSON.parse(l).payload.type === 'agent_message'));
});

test('validateRolloutFilename：合法通过，非法报错', () => {
  validateRolloutFilename('rollout-2026-08-21T01-00-00-123e4567-e89b-42d3-a456-426614174000.jsonl');
  assert.throws(() => validateRolloutFilename('session-123e4567-e89b-42d3-a456-426614174000.jsonl'), /前缀或过短/);
  assert.throws(() => validateRolloutFilename(`rollout-2026-08-21T01-00-00-${'x'.repeat(36)}.jsonl`), /UUID/);
});

test('importTurns → parse round-trip：路径布局正确且可还原等价时间线', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'tongbu-home-'));
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const cwd = '/a/b';
    const turns: UnifiedTurn[] = [
      { role: 'user', text: '第一问', timestamp: '2026-08-21T03:00:00.000Z' },
      { role: 'assistant', text: '第一答', timestamp: '2026-08-21T03:00:01.000Z', provider: 'claude' },
      { role: 'user', text: '第二问', timestamp: '2026-08-21T03:00:02.000Z' },
    ];
    const ref = await importTurnsToCodex(turns, cwd);
    assert.equal(ref.provider, 'codex');
    const rel = path.relative(path.join(home, '.codex', 'sessions'), ref.filePath);
    assert.match(rel, /^\d{4}\/\d{2}\/\d{2}\/rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[0-9a-f-]{36}\.jsonl$/);
    // round-trip：assistant 的 provider 归一为 codex；record timestamp 归一为导入时刻
    const back = await parseCodexSession(ref);
    assert.deepEqual(
      back.map((t) => ({ role: t.role, text: t.text, provider: t.provider })),
      [
        { role: 'user', text: '第一问', provider: undefined },
        { role: 'assistant', text: '第一答', provider: 'codex' },
        { role: 'user', text: '第二问', provider: undefined },
      ],
    );
    const raw = await readFile(ref.filePath, 'utf8');
    assert.equal(JSON.parse(raw.split('\n')[0]).type, 'session_meta');
  } finally {
    process.env.HOME = oldHome;
    await rm(home, { recursive: true, force: true });
  }
});

test('Rich round-trip：thinking + exec 进出仍在，Bash 映射为 exec', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'tongbu-home-'));
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const cwd = '/a/b';
    const turns: UnifiedTurn[] = [
      { role: 'user', text: '跑一下', timestamp: '2026-08-21T03:00:00.000Z' },
      {
        role: 'assistant',
        text: '调用完成',
        timestamp: '2026-08-21T03:00:04.000Z',
        provider: 'codex',
        events: [
          {
            kind: 'thinking',
            summary: '先列目录',
            detail: '先列目录再看 git',
            timestamp: '2026-08-21T03:00:01.000Z',
            provider: 'claude',
          },
          {
            kind: 'tool_call',
            summary: 'Bash: pwd',
            detail: '{"command":"pwd && ls -la"}',
            timestamp: '2026-08-21T03:00:02.000Z',
            provider: 'claude',
            name: 'Bash',
            callId: 'call-1',
            input: { command: 'pwd && ls -la', description: 'Show cwd' },
          },
          {
            kind: 'tool_result',
            summary: '工具返回',
            detail: '/a/b\nfile.txt',
            timestamp: '2026-08-21T03:00:03.000Z',
            provider: 'claude',
            callId: 'call-1',
          },
        ],
      },
    ];
    const ref = await importTurnsToCodex(turns, cwd);
    const raw = await readFile(ref.filePath, 'utf8');
    const items = raw
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .filter((r) => r.type === 'response_item')
      .map((r) => r.payload);
    assert.equal(items[0].type, 'message');
    const call = items.find((p) => p.type === 'custom_tool_call');
    const out = items.find((p) => p.type === 'custom_tool_call_output');
    const comments = items.filter((p) => p.phase === 'commentary');
    assert.equal(items.some((p) => p.type === 'reasoning'), true);
    assert.equal(call?.name, 'exec');
    assert.match(String(call?.input), /pwd && ls -la/);
    assert.ok(out);
    assert.equal(items.at(-1)?.phase, 'final_answer');
    assert.ok(comments.some((p) => String(p.content?.[0]?.text ?? '').includes('pwd && ls -la')));
    const back = await parseCodexSession(ref);
    assert.equal(back[1].text, '调用完成');
    assert.deepEqual(
      back[1].events?.map((e) => ({ kind: e.kind, name: e.name, detail: e.detail })),
      [
        { kind: 'thinking', name: undefined, detail: '先列目录再看 git' },
        { kind: 'tool_call', name: 'exec', detail: 'pwd && ls -la' },
        { kind: 'tool_result', name: undefined, detail: '/a/b\nfile.txt' },
      ],
    );
  } finally {
    process.env.HOME = oldHome;
    await rm(home, { recursive: true, force: true });
  }
});

test('sessionUsage：取最后一条 token_count.total_token_usage', async () => {
  const lines = [
    responseItem({ type: 'message', role: 'user', content: userContent('hi') }),
    eventMsg({ type: 'token_count', info: { total_token_usage: { input_tokens: 10, output_tokens: 5 } } }),
    eventMsg({ type: 'token_count', info: { total_token_usage: { input_tokens: 25, output_tokens: 12 } } }),
  ];
  await withTempFile(lines, async (ref) => {
    const u = await codexSessionUsage(ref);
    assert.deepEqual(u, { inputTokens: 25, outputTokens: 12 });
  });
});

test('sessionUsage：无 token_count 返回 null', async () => {
  await withTempFile(
    [responseItem({ type: 'message', role: 'user', content: userContent('hi') })],
    async (ref) => {
      const u = await codexSessionUsage(ref);
      assert.equal(u, null);
    },
  );
});

test('importTurns：拒绝非绝对路径 cwd', async () => {
  await assert.rejects(() => importTurnsToCodex([], 'relative/path'), /绝对路径/);
});

test('importTurns into：追加同一文件且不再写 session_meta', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'tongbu-home-'));
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const cwd = '/a/b';
    const first: UnifiedTurn[] = [
      { role: 'user', text: '第一问', timestamp: '2026-08-21T03:00:00.000Z' },
      { role: 'assistant', text: '第一答', timestamp: '2026-08-21T03:00:01.000Z' },
    ];
    const ref = await importTurnsToCodex(first, cwd);
    const extra: UnifiedTurn[] = [
      { role: 'user', text: '第二问', timestamp: '2026-08-21T03:00:02.000Z' },
      { role: 'assistant', text: '第二答', timestamp: '2026-08-21T03:00:03.000Z' },
    ];
    const again = await importTurnsToCodex(extra, cwd, ref);
    assert.equal(again.sessionId, ref.sessionId);
    assert.equal(again.filePath, ref.filePath);
    const raw = await readFile(ref.filePath, 'utf8');
    const records = raw
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { type: string });
    assert.equal(records.filter((r) => r.type === 'session_meta').length, 1);
    const back = await parseCodexSession(ref);
    assert.deepEqual(
      back.map((t) => t.text),
      ['第一问', '第一答', '第二问', '第二答'],
    );
  } finally {
    process.env.HOME = oldHome;
    await rm(home, { recursive: true, force: true });
  }
});


test('parse：custom_tool_call 字符串参数解析为对象（Read input 不再二次损坏）', async () => {
  await withTempFile(
    [
      responseItem({ type: 'message', role: 'user', content: userContent('读一下') }),
      responseItem({
        type: 'custom_tool_call',
        name: 'container.exec',
        call_id: 'call-r1',
        input: JSON.stringify({ file_path: '/a/b/package.json' }),
      }),
    ],
    async (ref) => {
      const turns = await parseCodexSession(ref);
      const ev = turns[1].events?.[0];
      assert.equal(ev?.kind, 'tool_call');
      assert.deepEqual(ev?.input, { file_path: '/a/b/package.json' });
    },
  );
});

test('parse：local_shell_call / web_search_call / agent_message 不再静默丢弃', async () => {
  await withTempFile(
    [
      responseItem({ type: 'message', role: 'user', content: userContent('查一下再答') }),
      responseItem({
        type: 'local_shell_call',
        call_id: 'ls_1',
        shell_command: 'ls -la',
        cwd: '/a/b',
        state: 'completed',
        output: 'a.txt\nb.txt',
      }),
      responseItem({ type: 'web_search_call', call_id: 'ws_1', query: 'codex 文档', output: '搜到一条' }),
      responseItem({ type: 'agent_message', role: 'assistant', content: assistantContent('我在查资料') }),
      responseItem({ type: 'message', role: 'assistant', content: assistantContent('最终答复') }),
    ],
    async (ref) => {
      const turns = await parseCodexSession(ref);
      assert.equal(turns.length, 2);
      const assistant = turns[1];
      assert.equal(assistant.text, '最终答复'); // 最终回复覆盖过程文本，未污染 turn.text
      const events = assistant.events ?? [];
      const calls = events.filter((e) => e.kind === 'tool_call');
      const results = events.filter((e) => e.kind === 'tool_result');
      const texts = events.filter((e) => e.kind === 'text');
      assert.equal(calls.length, 2);
      assert.equal(results.length, 2);
      assert.equal(texts.length, 1);
      assert.equal(calls[0]?.name, 'exec');
      assert.equal(calls[0]?.input, 'ls -la');
      assert.equal(calls[0]?.callId, 'ls_1');
      assert.equal(calls[1]?.name, 'web_search');
      assert.deepEqual(calls[1]?.input, { query: 'codex 文档' });
      assert.equal(texts[0]?.detail, '我在查资料');
    },
  );
});

test('parse：local_shell_call 无 output 时只留 tool_call（不滥造空 result）', async () => {
  await withTempFile(
    [
      responseItem({ type: 'message', role: 'user', content: userContent('跑一下') }),
      responseItem({ type: 'local_shell_call', call_id: 'ls_2', shell_command: 'true', state: 'completed' }),
    ],
    async (ref) => {
      const turns = await parseCodexSession(ref);
      const events = turns[1]?.events ?? [];
      assert.equal(events.filter((e) => e.kind === 'tool_result').length, 0);
      assert.equal(events.length, 1);
    },
  );
});

test('buildCodexLines：真实 usage 写入 token_count 的 input/output', async () => {
  const turns: UnifiedTurn[] = [
    { role: 'user', text: '查一下', timestamp: TS, provider: 'codex' },
    {
      role: 'assistant',
      text: '结果在这',
      timestamp: TS,
      provider: 'codex',
      usage: { inputTokens: 500, outputTokens: 30 },
    },
  ];
  const lines = buildCodexLines(turns, 's-u', '/a/b', 'codex', IDENTITY, NOW);
  const tokenCount = lines
    .map((l) => JSON.parse(l))
    .find((r) => r?.payload?.type === 'token_count')?.payload?.info?.total_token_usage;
  assert.ok(tokenCount, '应存在 token_count 记录');
  assert.equal(tokenCount.input_tokens, 500);
  assert.equal(tokenCount.output_tokens, 30);
  assert.equal(tokenCount.total_tokens, 530);
});
