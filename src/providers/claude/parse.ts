import { readFile } from 'node:fs/promises';
import {
  ENCRYPTED_THINKING,
  ensureAssistant,
  flattenToolOutput,
  pushEvent,
  stripEmptyEvents,
  summarize,
  unwrapUserQuery,
} from '../../core/rich.js';
import type { ProcessEvent, SessionRef, TokenUsage, UnifiedTurn } from '../../core/types.js';

/**
 * Claude JSONL → 统一时间线（Rich）：
 * - 跳过 isMeta/isSidechain、custom-title/ai-title、未知 type、坏行
 * - thinking / tool_use / tool_result 挂到当前 assistant.events
 * - 仅含 tool_result 的 user 记录不当作用户消息
 * - 同一 user turn 内多条 assistant 合并：过程事件累积，文本留最后一条非空
 * - 丢弃首条 user 之前的记录
 */
export async function parseClaudeSession(ref: SessionRef): Promise<UnifiedTurn[]> {
  const raw = await readFile(ref.filePath, 'utf8');
  const turns: UnifiedTurn[] = [];
  let sawUser = false;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record: unknown;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof record !== 'object' || record === null) continue;
    const r = record as Record<string, unknown>;
    const type = r.type;
    if (type !== 'user' && type !== 'assistant') continue;
    if (r.isMeta === true || r.isSidechain === true) continue;

    const timestamp = typeof r.timestamp === 'string' ? r.timestamp : '';
    const content = (r.message as Record<string, unknown> | undefined)?.content;
    const extracted = extractRich(content, timestamp);
    if (!extracted) continue;
    const { text, onlyToolResult, events } = extracted;

    if (type === 'user') {
      if (onlyToolResult) {
        if (!sawUser || turns.at(-1)?.role !== 'assistant') continue;
        const last = turns.at(-1)!;
        for (const ev of events) pushEvent(last, ev);
        continue;
      }
      sawUser = true;
      const userTurn: UnifiedTurn = { role: 'user', text: unwrapUserQuery(text), timestamp };
      if (events.length) userTurn.events = events;
      turns.push(userTurn);
    } else {
      if (!sawUser) continue;
      const last = ensureAssistant(turns, timestamp, 'claude');
      for (const ev of events) pushEvent(last, ev);
      if (text.trim()) last.text = text;
      if (timestamp) last.timestamp = timestamp;
      const usage = readUsage(r.message);
      if (usage) last.usage = usage;
    }
  }
  return stripEmptyEvents(turns);
}

/** 从 claude message 读真实 usage；缺字段或全 0 返回 undefined（避免把 0 占位当真实值） */
function readUsage(message: unknown): TokenUsage | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const usage = (message as Record<string, unknown>).usage;
  if (typeof usage !== 'object' || usage === null) return undefined;
  const u = usage as Record<string, unknown>;
  const inputTokens = typeof u.input_tokens === 'number' ? u.input_tokens : undefined;
  const outputTokens = typeof u.output_tokens === 'number' ? u.output_tokens : undefined;
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  if (inputTokens === 0 && outputTokens === 0) return undefined;
  return { inputTokens, outputTokens };
}

function extractRich(
  content: unknown,
  timestamp: string,
): { text: string; onlyToolResult: boolean; events: ProcessEvent[] } | null {
  let blocks: unknown[];
  if (typeof content === 'string') {
    blocks = [{ type: 'text', text: content }];
  } else if (Array.isArray(content)) {
    blocks = content;
  } else {
    return null;
  }
  const parts: string[] = [];
  const events: ProcessEvent[] = [];
  let sawVisible = false;
  let onlyToolResult = true;
  const base = { timestamp, provider: 'claude' as const };

  for (const block of blocks) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as Record<string, unknown>;
    switch (b.type) {
      case 'text':
        if (typeof b.text === 'string' && b.text !== '') {
          parts.push(b.text);
          sawVisible = true;
          onlyToolResult = false;
        }
        break;
      case 'thinking': {
        sawVisible = true;
        onlyToolResult = false;
        const thinking = typeof b.thinking === 'string' ? b.thinking : '';
        const detail = thinking.trim() ? thinking : ENCRYPTED_THINKING;
        events.push({
          ...base,
          kind: 'thinking',
          summary: thinking.trim() ? summarize(thinking, '思考') : ENCRYPTED_THINKING,
          detail,
        });
        break;
      }
      case 'redacted_thinking':
        sawVisible = true;
        onlyToolResult = false;
        events.push({ ...base, kind: 'thinking', summary: ENCRYPTED_THINKING, detail: ENCRYPTED_THINKING });
        break;
      case 'tool_use': {
        sawVisible = true;
        onlyToolResult = false;
        const name = typeof b.name === 'string' ? b.name : 'tool';
        const callId = typeof b.id === 'string' ? b.id : undefined;
        const input = b.input;
        const detail = typeof input === 'string' ? input : JSON.stringify(input ?? {});
        events.push({
          ...base,
          kind: 'tool_call',
          summary: summarize(detail, name),
          detail,
          name,
          callId,
          input,
        });
        break;
      }
      case 'tool_result': {
        sawVisible = true;
        const callId = typeof b.tool_use_id === 'string' ? b.tool_use_id : undefined;
        const detail = flattenToolOutput(b.content);
        events.push({
          ...base,
          kind: 'tool_result',
          summary: '工具返回',
          detail,
          callId,
        });
        break;
      }
      case 'image': {
        // 图像的「存在性占位文本」只进事件（summary/detail），不进 turn.text：
        // 否则写回还原 image block 后反解会生成两份占位（文本倍增，round-trip 对不上）。
        // attachment 携带原始数据，同侧 build 还原 image block；跨侧不支持时降级为仅事件摘要。
        sawVisible = true;
        onlyToolResult = false;
        const src =
          typeof b.source === 'object' && b.source !== null ? (b.source as Record<string, unknown>) : undefined;
        const media = typeof src?.media_type === 'string' && src.media_type ? src.media_type : 'image';
        const placeholder = (() => {
          if (typeof src?.data === 'string') return `[图片：${media}，${src.data.length}B]`;
          if (typeof src?.url === 'string') return `[图片：${media}（外部链接）]`;
          return `[图片：${media}]`;
        })();
        const attachment =
          typeof src?.data === 'string'
            ? { kind: 'image' as const, mediaType: media, data: src.data }
            : typeof src?.url === 'string'
              ? { kind: 'image' as const, mediaType: media, url: src.url }
              : undefined;
        if (attachment) {
          events.push({ ...base, kind: 'text', summary: placeholder, detail: placeholder, attachment });
        }
        break;
      }
    }
  }
  const text = parts
    .filter((p) => p.trim() !== '')
    .join('\n\n');
  if (!sawVisible) return null;
  return { text, onlyToolResult, events };
}


