import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseClaudeSession } from '../src/providers/claude/parse.js';
import { claudeSessionUsage } from '../src/providers/claude/usage.js';
import { buildClaudeLines, encodeClaudeProjectDir, importTurnsToClaude } from '../src/providers/claude/build.js';
import type { SessionRef, UnifiedTurn } from '../src/core/types.js';

async function withTempFile(lines: string[], fn: (ref: SessionRef) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'tongbu-'));
  const filePath = path.join(dir, 'session.jsonl');
  await writeFile(filePath, lines.join('\n') + '\n');
  try {
    await fn({ provider: 'claude', sessionId: 's1', filePath, cwd: '/a/b' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const rec = (over: Record<string, unknown>) =>
  JSON.stringify({
    type: 'user',
    isSidechain: false,
    cwd: '/a/b',
    sessionId: 's1',
    uuid: 'u1',
    timestamp: '2026-08-21T01:00:00.000Z',
    ...over,
  });

test('encodeClaudeProjectDir 与 cc-sessions 一致', () => {
  assert.equal(encodeClaudeProjectDir('/a/b/c'), '-a-b-c');
  assert.equal(encodeClaudeProjectDir('C:\\x'), 'C--x');
  assert.equal(encodeClaudeProjectDir('/home/u/项目 1'), '-home-u----1');
});

test('parse：过滤 isMeta/isSidechain/仅 tool_result 的 user，保最终回复和 thinking/tools', async () => {
  const lines = [
    rec({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '早于首条 user，丢弃' }] } }),
    rec({ isMeta: true, message: { role: 'user', content: 'meta 丢弃' } }),
    rec({ isSidechain: true, message: { role: 'user', content: 'sidechain 丢弃' } }),
    JSON.stringify({ type: 'custom-title', customTitle: '标题丢弃' }),
    'not json {{{',
    rec({
      message: { role: 'user', content: [{ type: 'text', text: '<user_query>你好</user_query>' }] },
      timestamp: '2026-08-21T01:00:01.000Z',
    }),
    rec({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '想...' },
          { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
        ],
      },
    }),
    rec({
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      timestamp: '2026-08-21T01:00:02.000Z',
    }),
    rec({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: '中间段' }] },
      timestamp: '2026-08-21T01:00:03.000Z',
    }),
    rec({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: '最终回复' }] },
      timestamp: '2026-08-21T01:00:04.000Z',
    }),
  ];
  await withTempFile(lines, async (ref) => {
    const turns = await parseClaudeSession(ref);
    assert.equal(turns.length, 2);
    assert.deepEqual(
      { role: turns[0].role, text: turns[0].text, timestamp: turns[0].timestamp },
      { role: 'user', text: '你好', timestamp: '2026-08-21T01:00:01.000Z' },
    );
    assert.equal(turns[1].role, 'assistant');
    assert.equal(turns[1].text, '最终回复');
    assert.equal(turns[1].timestamp, '2026-08-21T01:00:04.000Z');
    assert.equal(turns[1].provider, 'claude');
    assert.deepEqual(
      turns[1].events?.map((e) => ({ kind: e.kind, name: e.name, callId: e.callId, detail: e.detail })),
      [
        { kind: 'thinking', name: undefined, callId: undefined, detail: '想...' },
        { kind: 'tool_call', name: 'Bash', callId: 't1', detail: '{}' },
        { kind: 'tool_result', name: undefined, callId: 't1', detail: 'ok' },
      ],
    );
  });
});

test('parse：字符串 content 的 user 消息也能解析', async () => {
  await withTempFile([rec({ message: { role: 'user', content: '直接字符串' } })], async (ref) => {
    const turns = await parseClaudeSession(ref);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].text, '直接字符串');
  });
});

test('buildClaudeLines：parentUuid 链连续、首条 null、字段一致', () => {
  const turns: UnifiedTurn[] = [
    { role: 'user', text: '问题', timestamp: '2026-08-21T02:00:00.000Z' },
    { role: 'assistant', text: '回答', timestamp: '2026-08-21T02:00:01.000Z' },
  ];
  const lines = buildClaudeLines(turns, 'new-id', '/a/b', { model: 'claude-sonnet-4-5', version: '2.0.0' });
  assert.equal(lines.length, 2);
  const [r1, r2] = lines.map((l) => JSON.parse(l));
  assert.equal(r1.parentUuid, null);
  assert.equal(r2.parentUuid, r1.uuid);
  for (const r of [r1, r2]) {
    assert.equal(r.sessionId, 'new-id');
    assert.equal(r.cwd, '/a/b');
    assert.equal(r.isSidechain, false);
    assert.equal(r.userType, 'external');
    assert.equal(r.version, '2.0.0');
  }
  assert.equal(r2.message.role, 'assistant');
  assert.equal(r2.message.model, 'claude-sonnet-4-5');
  assert.equal(r2.message.stop_reason, 'end_turn');
  assert.deepEqual(r2.message.usage, { input_tokens: 0, output_tokens: 0 });
});

test('buildClaudeLines：无 user 消息时报错；空文本 turn 跳过', () => {
  assert.throws(
    () => buildClaudeLines([{ role: 'assistant', text: '只有回复', timestamp: '' }], 'x', '/a', { model: 'm' }),
    /没有可迁移的用户消息/,
  );
  const lines = buildClaudeLines(
    [
      { role: 'user', text: '问', timestamp: '2026-08-21T02:00:00.000Z' },
      { role: 'assistant', text: '  ', timestamp: '' },
    ],
    'x',
    '/a',
    { model: 'm' },
  );
  assert.equal(lines.length, 1);
});

test('importTurns → parse round-trip：产出文件可还原等价时间线', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'tongbu-home-'));
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const cwd = '/a/b';
    const turns: UnifiedTurn[] = [
      { role: 'user', text: '第一问', timestamp: '2026-08-21T03:00:00.000Z' },
      { role: 'assistant', text: '第一答', timestamp: '2026-08-21T03:00:01.000Z', provider: 'codex' },
      { role: 'user', text: '第二问', timestamp: '2026-08-21T03:00:02.000Z' },
    ];
    const ref = await importTurnsToClaude(turns, cwd);
    assert.equal(ref.provider, 'claude');
    assert.equal(
      ref.filePath,
      path.join(home, '.claude', 'projects', encodeClaudeProjectDir(cwd), `${ref.sessionId}.jsonl`),
    );
    // 文件含 parentUuid 链且首条为 null
    const raw = await readFile(ref.filePath, 'utf8');
    const records = raw.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(records[0].parentUuid, null);
    for (let i = 1; i < records.length; i++) {
      assert.equal(records[i].parentUuid, records[i - 1].uuid);
      assert.equal(records[i].sessionId, ref.sessionId);
    }
    // round-trip：assistant 的 provider 归一为 claude
    const back = await parseClaudeSession(ref);
    assert.deepEqual(back, [
      turns[0],
      { ...turns[1], provider: 'claude' },
      turns[2],
    ]);
  } finally {
    process.env.HOME = oldHome;
    await rm(home, { recursive: true, force: true });
  }
});

test('Rich round-trip：thinking 降级为 [思考] 文本，Bash 进出仍在', async () => {
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
        provider: 'claude',
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
    const ref = await importTurnsToClaude(turns, cwd);
    const raw = await readFile(ref.filePath, 'utf8');
    const records = raw.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(records[0].message.content[0].type, 'text');
    assert.equal(records[1].message.content[0].type, 'text');
    assert.equal(records[1].message.content[0].text, '[思考] 先列目录再看 git');
    assert.equal(records[2].message.content[0].type, 'tool_use');
    assert.equal(records[2].message.content[0].name, 'Bash');
    assert.equal(records[3].message.content[0].type, 'tool_result');
    assert.equal(records[4].message.content[0].type, 'text');
    const back = await parseClaudeSession(ref);
    assert.equal(back[1].text, '调用完成');
    assert.deepEqual(
      back[1].events?.map((e) => e.kind),
      ['tool_call', 'tool_result'],
    );
    assert.equal(back[1].events?.[0].name, 'Bash');
    assert.equal((back[1].events?.[0].input as { command: string }).command, 'pwd && ls -la');
    assert.equal(back[1].events?.[1].detail, '/a/b\nfile.txt');
  } finally {
    process.env.HOME = oldHome;
    await rm(home, { recursive: true, force: true });
  }
});

test('importTurns replace：同一 sessionId 整文件重写', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'tongbu-home-'));
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const cwd = '/a/b';
    const simple: UnifiedTurn[] = [
      { role: 'user', text: '跑一下', timestamp: '2026-08-21T03:00:00.000Z' },
      { role: 'assistant', text: '调用完成', timestamp: '2026-08-21T03:00:01.000Z' },
    ];
    const ref = await importTurnsToClaude(simple, cwd);
    const rich: UnifiedTurn[] = [
      simple[0],
      {
        ...simple[1],
        events: [
          {
            kind: 'tool_call',
            summary: 'Bash: pwd',
            detail: '{"command":"pwd"}',
            timestamp: simple[1].timestamp,
            provider: 'claude',
            name: 'Bash',
            callId: 'c1',
            input: { command: 'pwd' },
          },
          {
            kind: 'tool_result',
            summary: '工具返回',
            detail: '/a/b',
            timestamp: simple[1].timestamp,
            provider: 'claude',
            callId: 'c1',
          },
        ],
      },
    ];
    const again = await importTurnsToClaude(rich, cwd, ref, { replace: true });
    assert.equal(again.sessionId, ref.sessionId);
    const back = await parseClaudeSession(ref);
    assert.deepEqual(
      back.map((t) => t.text),
      ['跑一下', '调用完成'],
    );
    assert.equal(back[1].events?.[0].kind, 'tool_call');
    const raw = await readFile(ref.filePath, 'utf8');
    const kinds = raw
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l).message.content[0].type);
    assert.deepEqual(kinds, ['text', 'tool_use', 'tool_result', 'text']);
  } finally {
    process.env.HOME = oldHome;
    await rm(home, { recursive: true, force: true });
  }
});

test('sessionUsage：累加 result.usage 与 message.usage', async () => {
  const lines = [
    rec({ type: 'user', message: { role: 'user', content: 'hi' } }),
    rec({
      type: 'assistant',
      message: { role: 'assistant', content: 'a1', usage: { input_tokens: 10, output_tokens: 5 } },
    }),
    rec({ type: 'result', usage: { input_tokens: 12, output_tokens: 3 } }),
    rec({ type: 'result', usage: { input_tokens: 8, output_tokens: 7 } }),
  ];
  await withTempFile(lines, async (ref) => {
    const u = await claudeSessionUsage(ref);
    assert.deepEqual(u, { inputTokens: 30, outputTokens: 15 });
  });
});

test('parse：image block 保留存在性占位文本（不搬 base64）', async () => {
  await withTempFile(
    [
      rec({
        message: {
          role: 'user',
          content: [
            { type: 'text', text: '看图' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'ABCBASE64' } },
            { type: 'image', source: { type: 'url', media_type: 'image/jpeg', url: 'https://x/1.jpg' } },
          ],
        },
      }),
      rec({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: '看到了' }] },
      }),
    ],
    async (ref) => {
      const turns = await parseClaudeSession(ref);
      assert.equal(turns.length, 2);
      assert.equal(turns[0]!.text, '看图'); // 占位只在事件，不进 turn.text（防 round-trip 文本倍增）
      const img1 = (turns[0]?.events ?? []).find((e) => e.attachment?.kind === 'image' && e.attachment?.data);
      const img2 = (turns[0]?.events ?? []).find((e) => e.attachment?.kind === 'image' && e.attachment?.url);
      assert.equal(img1?.summary, '[图片：image/png，9B]');
      assert.equal(img2?.summary, '[图片：image/jpeg（外部链接）]');
      assert.equal(turns[1]!.text, '看到了');
    },
  );
});

test('parse：纯 image user 消息不再消失（占位在事件，round-trip 可还原）', async () => {
  await withTempFile(
    [
      rec({
        message: {
          role: 'user',
          content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }],
        },
      }),
    ],
    async (ref) => {
      const turns = await parseClaudeSession(ref);
      assert.equal(turns.length, 1);
      assert.equal(turns[0]!.events?.[0]?.summary, '[图片：image/png，3B]');
      // build 把 image 还原成原生 block 写回，可正常续聊
      const built = buildClaudeLines(turns, 's1', '/a/b', { model: 'test' }, {});
      assert.ok(built.some((l) => l.includes('"type":"image"')));
      assert.ok(built.some((l) => l.includes('"data":"AAA"' /* base64 完整保留 */)));
    },
  );
});

test('图片闭环：parse→build→parse 还原 image block + attachment', async () => {
  // 源带内联图片（base64），经 importTurnsToClaude 写回后 image block 必须可还原
  await withTempFile(
    [
      rec({
        message: {
          role: 'user',
          content: [
            { type: 'text', text: '看图' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJDREVG' } },
          ],
        },
      }),
      rec({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: '看到了' }] },
      }),
    ],
    async (ref) => {
      const turns = await parseClaudeSession(ref);
      const imgEv = (turns[0]?.events ?? []).find((e) => e.kind === 'text' && e.attachment?.kind === 'image');
      assert.ok(imgEv, 'image 事件应带 attachment');
      assert.equal(imgEv.attachment!.data, 'QUJDREVG');
      assert.equal(turns[0]!.text, '看图');

      // 写回新会话，再反解：image block 还原、数据一致、文本不变
      const outRef = await importTurnsToClaude(turns, '/a/b', undefined);
      const back = await parseClaudeSession(outRef);
      assert.equal(back.length, 2);
      assert.equal(back[0]!.text, '看图');
      const backImg = (back[0]?.events ?? []).find((e) => e.kind === 'text' && e.attachment?.kind === 'image');
      assert.ok(backImg, '写回后 image 仍在');
      assert.equal(backImg!.attachment!.data, 'QUJDREVG');
      assert.ok(!back.some((t) => t.text.includes('undefined')));
    },
  );
});

test('image：外部链接型保留 url（不搬数据）', async () => {
  await withTempFile(
    [
      rec({
        message: {
          role: 'user',
          content: [{ type: 'image', source: { type: 'url', media_type: 'image/png', url: 'https://x/1.png' } }],
        },
      }),
    ],
    async (ref) => {
      const turns = await parseClaudeSession(ref);
      const imgEv = (turns[0]?.events ?? []).find((e) => e.kind === 'text' && e.attachment?.kind === 'image');
      assert.equal(imgEv?.attachment?.url, 'https://x/1.png');
      assert.equal(imgEv?.attachment?.data, undefined);
    },
  );
});

test('sessionUsage：无 usage 字段返回 null', async () => {
  await withTempFile([rec({ type: 'user', message: { role: 'user', content: 'hi' } })], async (ref) => {
    const u = await claudeSessionUsage(ref);
    assert.equal(u, null);
  });
});

test('importTurns：拒绝非绝对路径 cwd', async () => {
  await assert.rejects(() => importTurnsToClaude([], 'relative/path'), /绝对路径/);
});

test('importTurns into：追加同一 sessionId，parentUuid 接上原链', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'tongbu-home-'));
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const cwd = '/a/b';
    const first: UnifiedTurn[] = [
      { role: 'user', text: '第一问', timestamp: '2026-08-21T03:00:00.000Z' },
      { role: 'assistant', text: '第一答', timestamp: '2026-08-21T03:00:01.000Z' },
    ];
    const ref = await importTurnsToClaude(first, cwd);
    const extra: UnifiedTurn[] = [
      { role: 'user', text: '第二问', timestamp: '2026-08-21T03:00:02.000Z' },
      { role: 'assistant', text: '第二答', timestamp: '2026-08-21T03:00:03.000Z' },
    ];
    const again = await importTurnsToClaude(extra, cwd, ref);
    assert.equal(again.sessionId, ref.sessionId);
    assert.equal(again.filePath, ref.filePath);
    const raw = await readFile(ref.filePath, 'utf8');
    const records = raw.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(records.length, 4);
    assert.equal(records[2].parentUuid, records[1].uuid);
    assert.equal(records[2].sessionId, ref.sessionId);
    const back = await parseClaudeSession(ref);
    assert.deepEqual(
      back.map((t) => t.text),
      ['第一问', '第一答', '第二问', '第二答'],
    );
  } finally {
    process.env.HOME = oldHome;
    await rm(home, { recursive: true, force: true });
  }
});

test('parse：assistant message 读真实 usage 进 turn.usage', async () => {
  await withTempFile(
    [
      rec({
        message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        timestamp: '2026-08-21T04:00:00.000Z',
      }),
      rec({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'hi there' }],
          usage: { input_tokens: 21333, output_tokens: 490 },
        },
      }),
    ],
    async (ref) => {
      const turns = await parseClaudeSession(ref);
      assert.deepEqual(turns[1]!.usage, { inputTokens: 21333, outputTokens: 490 });
    },
  );
});

test('parse：全 0 / 缺字段 usage 不落 turn.usage', async () => {
  await withTempFile(
    [
      rec({
        message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        timestamp: '2026-08-21T04:00:00.000Z',
      }),
      rec({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'a' }], usage: { input_tokens: 0, output_tokens: 0 } },
      }),
      rec({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'b' }] },
      }),
    ],
    async (ref) => {
      const turns = await parseClaudeSession(ref);
      assert.equal(turns[1]!.usage, undefined);
    },
  );
});

test('usage round-trip：写回真实 input/output，再反解逐位一致', async () => {
  const turns: UnifiedTurn[] = [
    { role: 'user', text: '第一问', timestamp: '2026-08-21T05:00:00.000Z' },
    { role: 'assistant', text: '第一答', timestamp: '2026-08-21T05:00:01.000Z', usage: { inputTokens: 100, outputTokens: 20 } },
    { role: 'user', text: '第二问', timestamp: '2026-08-21T05:00:02.000Z' },
    { role: 'assistant', text: '第二答', timestamp: '2026-08-21T05:00:03.000Z', usage: { inputTokens: 0, outputTokens: 50 } },
  ];
  const ref = await importTurnsToClaude(turns, '/a/b', undefined);
  const back = await parseClaudeSession(ref);
  assert.equal(back.length, 4);
  assert.deepEqual(back[1]!.usage, { inputTokens: 100, outputTokens: 20 });
  assert.deepEqual(back[3]!.usage, { inputTokens: 0, outputTokens: 50 });
});

test('user 侧非图片附件：claude 降级为占位文本（不无声），round-trip 文本一致', async () => {
  const turns: UnifiedTurn[] = [
    {
      role: 'user',
      text: '',
      timestamp: '2026-08-21T05:10:00.000Z',
      events: [
        {
          kind: 'text',
          summary: '[附件：image/png，约22B x.png]',
          detail: '[附件：image/png，约22B x.png]',
          timestamp: '2026-08-21T05:10:00.000Z',
          provider: 'opencode',
          attachment: { kind: 'file', mediaType: 'image/png', url: 'data:image/png;base64,AAAA', filename: 'x.png' },
        },
      ],
    },
    { role: 'assistant', text: '看到了', timestamp: '2026-08-21T05:10:01.000Z' },
  ];
  const ref = await importTurnsToClaude(turns, '/a/b', undefined);
  const back = await parseClaudeSession(ref);
  assert.equal(back.length, 2);
  assert.equal(back[0]!.text, '[附件：image/png，约22B x.png]');
  assert.equal(back[1]!.text, '看到了');
});
