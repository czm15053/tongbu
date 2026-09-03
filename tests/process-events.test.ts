import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeLineToProcessEvents, claudeResultFromStream, toolCallSummary, truncateDetail } from '../src/providers/claude/events.js';
import { codexLineToProcessEvents } from '../src/providers/codex/events.js';

// ---------- claude 事件解析 ----------

test('claude: assistant thinking（无签名）→ thinking 事件', () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'thinking', thinking: '先分析需求\n再动手', }] },
  });
  const events = claudeLineToProcessEvents(line);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'thinking');
  assert.equal(events[0].summary, '思考: 先分析需求');
  assert.equal(events[0].detail, '先分析需求\n再动手');
  assert.equal(events[0].provider, 'claude');
});

test('claude: 带 signature 的 thinking → 加密占位，detail 为空', () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'thinking', thinking: '明文不该展示', signature: 'sig-xxx' }] },
  });
  const events = claudeLineToProcessEvents(line);
  assert.equal(events[0].summary, '思考中…（加密）');
  assert.equal(events[0].detail, undefined);
});

test('claude: redacted_thinking → 已隐藏占位', () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'redacted_thinking', data: 'xxx' }] },
  });
  assert.equal(claudeLineToProcessEvents(line)[0].summary, '思考中…（已隐藏）');
});

test('claude: tool_use → tool_call，摘要挑关键参数', () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } }] },
  });
  const events = claudeLineToProcessEvents(line);
  assert.equal(events[0].kind, 'tool_call');
  assert.equal(events[0].summary, 'Bash: ls -la');
});

test('claude: user tool_result（string / text 数组两种 content）→ tool_result', () => {
  const s = claudeLineToProcessEvents(JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', content: 'done' }] },
  }));
  assert.equal(s[0].kind, 'tool_result');
  assert.equal(s[0].detail, 'done');
  const arr = claudeLineToProcessEvents(JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }] },
  }));
  assert.equal(arr[0].detail, 'a\nb');
});

test('claude: system / result 行不产事件；坏行不抛错', () => {
  assert.equal(claudeLineToProcessEvents(JSON.stringify({ type: 'system', subtype: 'init' })).length, 0);
  assert.equal(claudeLineToProcessEvents(JSON.stringify({ type: 'result', result: 'x' })).length, 0);
  assert.equal(claudeLineToProcessEvents('not json').length, 0);
});

test('claude: claudeResultFromStream 取末条 result 行', () => {
  const stdout = [
    JSON.stringify({ type: 'system', subtype: 'init' }),
    JSON.stringify({ type: 'result', result: '旧', is_error: false }),
    JSON.stringify({ type: 'result', result: '最终', is_error: false, session_id: 's1' }),
  ].join('\n');
  const r = claudeResultFromStream(stdout);
  assert.equal(r?.result, '最终');
  assert.equal(r?.session_id, 's1');
  assert.equal(claudeResultFromStream('{"type":"assistant"}'), null);
});

test('claude: toolCallSummary 各工具参数优先级；truncateDetail 截断 500', () => {
  assert.equal(toolCallSummary('Read', { file_path: '/a/b.ts' }), 'Read: /a/b.ts');
  assert.equal(toolCallSummary('Grep', { pattern: 'foo' }), 'Grep: foo');
  assert.equal(toolCallSummary('WebFetch', { url: 'https://x.com' }), 'WebFetch: https://x.com');
  assert.equal(toolCallSummary('Unknown', {}), 'Unknown');
  const long = 'y'.repeat(600);
  assert.equal(truncateDetail(long).length, 501);
  assert.ok(truncateDetail(long).endsWith('…'));
});

// ---------- codex 事件解析 ----------

test('codex: item.completed reasoning → thinking；无 text → 加密占位', () => {
  const plain = codexLineToProcessEvents(JSON.stringify({
    type: 'item.completed',
    item: { type: 'reasoning', text: '先看看目录结构\n然后改代码' },
  }));
  assert.equal(plain[0].kind, 'thinking');
  assert.equal(plain[0].summary, '思考: 先看看目录结构');
  const encrypted = codexLineToProcessEvents(JSON.stringify({
    type: 'item.completed',
    item: { type: 'reasoning', encrypted_content: 'xxx' },
  }));
  assert.equal(encrypted[0].summary, '思考中…（加密）');
});

test('codex: function_call / function_call_output → tool_call / tool_result', () => {
  const call = codexLineToProcessEvents(JSON.stringify({
    type: 'item.completed',
    item: { type: 'function_call', name: 'shell', arguments: '{"command":"ls"}' },
  }));
  assert.equal(call[0].kind, 'tool_call');
  assert.ok(call[0].summary.startsWith('shell: '));
  const out = codexLineToProcessEvents(JSON.stringify({
    type: 'item.completed',
    item: { type: 'function_call_output', output: 'file1\nfile2' },
  }));
  assert.equal(out[0].kind, 'tool_result');
  assert.equal(out[0].summary, '工具返回');
  assert.equal(out[0].detail, 'file1\nfile2');
});

test('codex: commentary agent_message → text；final_answer 不产事件', () => {
  const commentary = codexLineToProcessEvents(JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', phase: 'commentary', text: '我先查一下' },
  }));
  assert.equal(commentary[0].kind, 'text');
  assert.equal(commentary[0].summary, '我先查一下');
  const final = codexLineToProcessEvents(JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', phase: 'final_answer', text: '最终回复' },
  }));
  assert.equal(final.length, 0);
  const noPhase = codexLineToProcessEvents(JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: '最终回复' },
  }));
  assert.equal(noPhase.length, 0);
});

test('codex: thread.started / turn.* / 坏行不产事件', () => {
  assert.equal(codexLineToProcessEvents(JSON.stringify({ type: 'thread.started', thread_id: 't1' })).length, 0);
  assert.equal(codexLineToProcessEvents(JSON.stringify({ type: 'turn.completed' })).length, 0);
  assert.equal(codexLineToProcessEvents('garbage').length, 0);
});

test('codex: command_execution completed → tool_call + tool_result', () => {
  const events = codexLineToProcessEvents(JSON.stringify({
    type: 'item.completed',
    item: {
      type: 'command_execution',
      command: "/bin/zsh -lc 'echo test-events'",
      aggregated_output: 'test-events\n',
      exit_code: 0,
      status: 'completed',
    },
  }));
  assert.equal(events.length, 2);
  assert.equal(events[0].kind, 'tool_call');
  assert.equal(events[0].summary, "shell: /bin/zsh -lc 'echo test-events'");
  assert.equal(events[1].kind, 'tool_result');
  assert.equal(events[1].detail, 'test-events\n');
  // 无输出时只有 tool_call
  const noOut = codexLineToProcessEvents(JSON.stringify({
    type: 'item.completed',
    item: { type: 'command_execution', command: 'ls', aggregated_output: '', status: 'completed' },
  }));
  assert.equal(noOut.length, 1);
  assert.equal(noOut[0].kind, 'tool_call');
});
