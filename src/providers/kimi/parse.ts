import { readFile } from 'node:fs/promises';
import { ensureAssistant, normalizeUserText, pushEvent, stripEmptyEvents, summarize } from '../../core/rich.js';
import type { ProcessEvent, SessionRef, TokenUsage, UnifiedTurn } from '../../core/types.js';

/**
 * Kimi wire.jsonl → UnifiedTurn[]
 *
 * 关键事件（协议 1.4/1.5）：
 * - turn.prompt / turn.steer，origin.kind = 'user' → user turn
 * - context.append_loop_event
 *   - content.part type=text → assistant text
 *   - content.part type=think → thinking event
 *   - tool.call → tool_call event
 *   - tool.result → tool_result event
 * - turn.ended → assistant turn 结束
 *
 * 跳过：context.append_message（与 turn.prompt 重复）、llm.*、usage.*、
 * permission.*、plugin.*、token_counting.*、interaction.* 等内部事件。
 */
export async function parseKimiSession(ref: SessionRef): Promise<UnifiedTurn[]> {
  const raw = await readFile(ref.filePath, 'utf8');
  const turns: UnifiedTurn[] = [];
  let state: 'idle' | 'user' | 'assistant' = 'idle';

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
    const time = typeof r.time === 'number' ? r.time : undefined;
    const timestamp = time ? new Date(time).toISOString() : '';

    if (type === 'turn.prompt' || type === 'turn.steer') {
      const text = extractUserText(r);
      if (text === null) continue;
      const normalized = normalizeUserText(text);
      if (normalized === null) continue;
      turns.push({ role: 'user', text: normalized, timestamp });
      state = 'user';
      continue;
    }

    if (type === 'context.append_loop_event') {
      const event = asRecord(r.event);
      if (!event) continue;

      // loop 事件属于 assistant turn；若当前刚进入 user，则创建 assistant
      if (state === 'user' || state === 'idle') {
        state = 'assistant';
      }
      if (state !== 'assistant') continue;

      const last = ensureAssistant(turns, timestamp, 'kimi');
      processLoopEvent(event, last, timestamp);
      continue;
    }

    if (type === 'usage.record') {
      // 原生 kimi 把用量记成独立 usage.record 事件，归属最后一次 assistant 回复
      const usage = usageFromRecord(asRecord(r.usage));
      if (usage && turns.at(-1)?.role === 'assistant') turns.at(-1)!.usage = usage;
      continue;
    }

    if (type === 'turn.ended') {
      state = 'idle';
      continue;
    }
  }

  return stripEmptyEvents(turns);
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** kimi usage 形状（usage.record 与 step.end.usage 共用）：input 含缓存读/建 */
function usageFromRecord(usage: Record<string, unknown> | null): TokenUsage | undefined {
  if (!usage) return undefined;
  const input = num(usage.inputOther) + num(usage.inputCacheRead) + num(usage.inputCacheCreation);
  const output = num(usage.output);
  if (input === 0 && output === 0) return undefined;
  return { inputTokens: input, outputTokens: output };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => (typeof v === 'string' ? v : '')).filter((s) => s !== '');
}

/** 从 turn.prompt / turn.steer 提取用户文本 */
function extractUserText(r: Record<string, unknown>): string | null {
  const origin = asRecord(r.origin);
  if (asString(origin?.kind) !== 'user') return null;
  const input = r.input;
  if (!Array.isArray(input)) return null;
  const parts: string[] = [];
  for (const block of input) {
    const b = asRecord(block);
    if (b?.type === 'text') {
      const text = asString(b.text);
      if (text) parts.push(text);
    }
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

function processLoopEvent(event: Record<string, unknown>, turn: UnifiedTurn, timestamp: string): void {
  const loopType = asString(event.type);
  if (!loopType) return;
  const base = { timestamp, provider: 'kimi' as const };

  // 我们 build 把用量写在 step.end 的 usage 字段（最后一个 step 覆盖前一个）
  if (loopType === 'step.end') {
    const usage = usageFromRecord(asRecord(event.usage));
    if (usage) turn.usage = usage;
    return;
  }

  if (loopType === 'content.part') {
    const part = asRecord(event.part);
    if (!part) return;
    const partType = asString(part.type);
    if (partType === 'text') {
      const text = asString(part.text);
      if (text) turn.text = turn.text ? `${turn.text}\n\n${text}` : text;
      return;
    }
    if (partType === 'think') {
      const think = asString(part.think);
      if (!think) return;
      pushEvent(turn, {
        ...base,
        kind: 'thinking',
        summary: summarize(think, '思考中…'),
        detail: think,
      });
      return;
    }
    return;
  }

  if (loopType === 'tool.call') {
    const name = asString(event.name);
    const callId = asString(event.toolCallId) ?? asString(event.uuid);
    if (!name || !callId) return;
    pushEvent(turn, {
      ...base,
      kind: 'tool_call',
      summary: summarize(`${name}: ${JSON.stringify(event.args ?? {})}`, name),
      detail: JSON.stringify(event.args ?? {}),
      name,
      callId,
      input: event.args ?? {},
    });
    return;
  }

  if (loopType === 'tool.result') {
    const callId = asString(event.toolCallId) ?? asString(event.parentUuid);
    if (!callId) return;
    const result = asRecord(event.result);
    const output = result?.output ?? '';
    const detail = typeof output === 'string' ? output : JSON.stringify(output);
    pushEvent(turn, {
      ...base,
      kind: 'tool_result',
      summary: detail ? summarize(detail, '工具返回') : '工具返回',
      detail,
      callId,
    });
    return;
  }
}
