import { readFile } from 'node:fs/promises';
import { ensureAssistant, normalizeUserText, pushEvent, stripEmptyEvents, summarize } from '../../core/rich.js';
import type { ProcessEvent, SessionRef, UnifiedTurn } from '../../core/types.js';

export async function parsePiSession(ref: SessionRef): Promise<UnifiedTurn[]> {
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
    if (r.type !== 'message') continue;
    const msg = r.message as Record<string, unknown> | undefined;
    if (!msg) continue;
    const role = msg.role;
    const timestamp =
      typeof r.timestamp === 'string'
        ? r.timestamp
        : typeof msg.timestamp === 'number'
          ? new Date(msg.timestamp).toISOString()
          : '';
    const content = Array.isArray(msg.content) ? msg.content : [];
    const extracted = extractBlocks(content, timestamp);

    if (role === 'user') {
      const text = normalizeUserText(extracted.text);
      if (!text) continue;
      sawUser = true;
      turns.push({ role: 'user', text, timestamp });
      continue;
    }
    if (role === 'toolResult') {
      if (!sawUser || turns.at(-1)?.role !== 'assistant') continue;
      const last = turns.at(-1)!;
      const callId = typeof msg.toolCallId === 'string' ? msg.toolCallId : undefined;
      const name = typeof msg.toolName === 'string' ? msg.toolName : undefined;
      pushEvent(last, {
        kind: 'tool_result',
        summary: extracted.text.slice(0, 80) || 'tool result',
        detail: extracted.text || undefined,
        timestamp,
        provider: 'pi',
        name,
        callId,
      });
      continue;
    }
    if (role !== 'assistant') continue;
    if (!sawUser) continue;

    // Pi build 会把有 tool 的 assistant final text 拆成一条独立 message 跟在 toolResult 后面，
    // 解析时合并回同一个 UnifiedTurn，避免一个回合变成两个 assistant 回合。
    const prev = turns.at(-1);
    if (
      prev?.role === 'assistant' &&
      extracted.events.length === 0 &&
      extracted.text.trim() &&
      (prev.events?.length ?? 0) > 0 &&
      !prev.text.trim()
    ) {
      prev.text = extracted.text;
      if (timestamp) prev.timestamp = timestamp;
      continue;
    }

    const last = ensureAssistant(turns, timestamp, 'pi');
    for (const ev of extracted.events) pushEvent(last, ev);
    if (extracted.text.trim()) last.text = extracted.text;
    if (timestamp) last.timestamp = timestamp;
  }
  return stripEmptyEvents(turns);
}

function extractBlocks(
  blocks: unknown[],
  timestamp: string,
): { text: string; events: ProcessEvent[] } {
  const texts: string[] = [];
  const events: ProcessEvent[] = [];
  for (const block of blocks) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as Record<string, unknown>;
    const type = b.type;
    if (type === 'text' && typeof b.text === 'string') texts.push(b.text);
    else if (type === 'thinking') {
      const thinking = typeof b.thinking === 'string' ? b.thinking : '';
      events.push({
        kind: 'thinking',
        summary: thinking ? summarize(thinking, '思考中…') : '思考中…',
        detail: thinking || undefined,
        timestamp,
        provider: 'pi',
      });
    } else if (type === 'toolCall') {
      const name = typeof b.name === 'string' ? b.name : 'tool';
      const callId = typeof b.id === 'string' ? b.id : undefined;
      events.push({
        kind: 'tool_call',
        summary: `${name}`,
        timestamp,
        provider: 'pi',
        name,
        callId,
        input: b.arguments,
      });
    } else if (type === 'text' && b.text == null && typeof b.content === 'string') {
      texts.push(b.content);
    }
  }
  return { text: texts.join('\n'), events };
}
