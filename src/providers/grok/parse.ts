import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ensureAssistant, normalizeUserText, pushEvent, stripEmptyEvents, summarize } from '../../core/rich.js';
import type { ProcessEvent, SessionRef, UnifiedTurn } from '../../core/types.js';

type ChatLine =
  | { type: 'system'; content: string }
  | { type: 'user'; content: unknown }
  | {
      type: 'assistant';
      content?: string;
      tool_calls?: Array<{ id?: string; name?: string; arguments?: string }>;
      model_id?: string;
    }
  | { type: 'tool_result'; tool_call_id?: string; content?: unknown }
  | {
      type: 'reasoning';
      id?: string;
      summary?: Array<{ type?: string; text?: string }>;
      encrypted_content?: string;
      status?: string;
    }
  | { type: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return null;
}

function extractUserText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    const b = asRecord(block);
    if (b?.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  }
  return parts.join('\n');
}

function parseToolArguments(raw: unknown): unknown {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw ?? {};
}

function parseToolOutput(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  try {
    return JSON.stringify(raw);
  } catch {
    return String(raw);
  }
}

export async function parseGrokSession(ref: SessionRef): Promise<UnifiedTurn[]> {
  const raw = await readFile(ref.filePath, 'utf8');
  const turns: UnifiedTurn[] = [];
  let sawUser = false;
  // 会话级按 callId 去重：CLI 会在行内重复登记调用，resume 重放还会让同一调用跨代再现，
  // 同一 callId 语义上就是一次调用，只保留首次
  const seenCallIds = new Set<string>();
  const seenResultIds = new Set<string>();
  // chat_history.jsonl 行内无时间戳；用同目录 summary.json 的真实 created_at 做会话锚点，
  // 行程内单调 +1ms 递增，避免历史消息被打上 `now()` 造成的重放漂移（summary 缺失时回退旧行为）。
  const anchor = await readGrokCreatedAt(ref.filePath);
  let lineIndex = 0;

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const r = asRecord(record);
    if (!r) continue;
    const type = typeof r.type === 'string' ? r.type : '';
    const timestamp = grokTimestamp(anchor, lineIndex);
    lineIndex += 1;

    if (type === 'user') {
      const text = normalizeUserText(extractUserText(r.content));
      if (!text) continue;
      sawUser = true;
      turns.push({ role: 'user', text, timestamp });
      continue;
    }

    if (type === 'assistant') {
      if (!sawUser) continue;
      const content = typeof r.content === 'string' ? r.content : '';
      const toolCalls = Array.isArray(r.tool_calls) ? r.tool_calls : [];

      // Grok 把 tool_calls 和最终文本拆成两条 assistant 行；
      // 解析时合并回同一个 UnifiedTurn，保持 round-trip 稳定。
      if (content.trim() && toolCalls.length === 0) {
        const prev = turns.at(-1);
        if (
          prev?.role === 'assistant' &&
          (prev.events ?? []).some((e) => e.kind === 'tool_call')
        ) {
          prev.text = prev.text ? `${prev.text}\n\n${content}` : content;
          continue;
        }
      }

      const assistant = ensureAssistant(turns, timestamp, 'grok');
      if (content.trim()) assistant.text = content;
      for (const tc of toolCalls) {
        const t = asRecord(tc);
        if (!t) continue;
        const name = typeof t.name === 'string' ? t.name : 'tool';
        const callId = typeof t.id === 'string' ? t.id : undefined;
        if (callId && seenCallIds.has(callId)) continue;
        if (callId) seenCallIds.add(callId);
        pushEvent(assistant, {
          kind: 'tool_call',
          name,
          callId,
          input: parseToolArguments(t.arguments),
          summary: `${name}: ${typeof t.arguments === 'string' ? t.arguments.slice(0, 200) : JSON.stringify(t.arguments ?? {}).slice(0, 200)}`,
          detail: typeof t.arguments === 'string' ? t.arguments : JSON.stringify(t.arguments ?? {}),
          timestamp,
          provider: 'grok',
        });
      }
      continue;
    }

    if (type === 'tool_result') {
      if (!sawUser || turns.at(-1)?.role !== 'assistant') continue;
      const last = turns.at(-1)!;
      const callId = typeof r.tool_call_id === 'string' ? r.tool_call_id : undefined;
      // 重放历史里同一调用的 result 也会跨代再现，同 id 只留首个
      if (callId && seenResultIds.has(callId)) continue;
      if (callId) seenResultIds.add(callId);
      const output = parseToolOutput(r.content);
      pushEvent(last, {
        kind: 'tool_result',
        callId,
        summary: summarize(output, '工具返回'),
        detail: output,
        timestamp,
        provider: 'grok',
      });
      continue;
    }

    if (type === 'reasoning') {
      if (!sawUser) continue;
      const last = ensureAssistant(turns, timestamp, 'grok');
      const summaryParts = Array.isArray(r.summary)
        ? r.summary
            .map((s) => {
              const rec = asRecord(s);
              return typeof rec?.text === 'string' ? rec.text : '';
            })
            .filter(Boolean)
            .join('\n')
        : '';
      const text = summaryParts || (r.encrypted_content ? '思考中…（加密）' : '思考中…');
      pushEvent(last, {
        kind: 'thinking',
        summary: summarize(text, '思考中…'),
        detail: text,
        timestamp,
        provider: 'grok',
      });
      continue;
    }
  }

  return stripEmptyEvents(turns);
}

async function readGrokCreatedAt(filePath: string): Promise<string | null> {
  try {
    const summary = JSON.parse(await readFile(join(dirname(filePath), 'summary.json'), 'utf8')) as {
      created_at?: unknown;
    };
    return typeof summary.created_at === 'string' && summary.created_at ? summary.created_at : null;
  } catch {
    return null;
  }
}

function grokTimestamp(anchor: string | null, index: number): string {
  if (!anchor) return isoTimestamp();
  const t = Date.parse(anchor);
  if (Number.isNaN(t)) return isoTimestamp();
  return new Date(t + index).toISOString();
}

function isoTimestamp(): string {
  return new Date().toISOString();
}
