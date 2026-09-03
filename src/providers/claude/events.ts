import type { ProcessEvent } from '../../core/types.js';

const MAX_DETAIL = 500;

export const truncateDetail = (s: string): string =>
  s.length > MAX_DETAIL ? `${s.slice(0, MAX_DETAIL)}…` : s;

/** 工具调用的单行摘要：按工具挑最有信息量的参数 */
export function toolCallSummary(name: string, input: unknown): string {
  if (typeof input === 'object' && input !== null) {
    const i = input as Record<string, unknown>;
    const key =
      (typeof i.command === 'string' && i.command) || // Bash
      (typeof i.file_path === 'string' && i.file_path) || // Read/Write/Edit
      (typeof i.pattern === 'string' && i.pattern) || // Glob/Grep
      (typeof i.path === 'string' && i.path) ||
      (typeof i.prompt === 'string' && i.prompt) ||
      (typeof i.url === 'string' && i.url) ||
      '';
    if (key) return `${name}: ${truncateDetail(key).split('\n')[0]}`;
  }
  return name;
}

const stamp = (): string => new Date().toISOString();

/** content block 的文本提取（tool_result 的 content 可为 string 或 text 数组） */
function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === 'object' && b !== null && typeof (b as Record<string, unknown>).text === 'string'
        ? (b as Record<string, unknown>).text as string
        : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/**
 * claude stream-json 一行 → 过程事件（仅展示）：
 * - assistant blocks：thinking（带 signature → 加密占位）/ tool_use / text（中间说明）
 * - user blocks：tool_result
 * - system（hook / thinking_tokens / init）与 result 行不产事件
 */
export function claudeLineToProcessEvents(line: string): ProcessEvent[] {
  let e: Record<string, unknown>;
  try {
    e = JSON.parse(line);
  } catch {
    return [];
  }
  if (e.type !== 'assistant' && e.type !== 'user') return [];
  const content = (e.message as Record<string, unknown> | undefined)?.content;
  if (!Array.isArray(content)) return [];

  const events: ProcessEvent[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as Record<string, unknown>;
    const base = { timestamp: stamp(), provider: 'claude' };
    switch (b.type) {
      case 'thinking': {
        const encrypted = typeof b.signature === 'string' && b.signature.length > 0;
        const text = typeof b.thinking === 'string' ? b.thinking : '';
        events.push({
          ...base,
          kind: 'thinking',
          summary: encrypted || !text ? '思考中…（加密）' : `思考: ${text.split('\n')[0].slice(0, 80)}`,
          detail: encrypted ? undefined : truncateDetail(text),
        });
        break;
      }
      case 'redacted_thinking':
        events.push({ ...base, kind: 'thinking', summary: '思考中…（已隐藏）' });
        break;
      case 'tool_use':
        if (typeof b.name === 'string') {
          events.push({ ...base, kind: 'tool_call', summary: toolCallSummary(b.name, b.input), detail: truncateDetail(JSON.stringify(b.input ?? {})) });
        }
        break;
      case 'tool_result': {
        const text = blockText(b.content);
        events.push({ ...base, kind: 'tool_result', summary: '工具返回', detail: truncateDetail(text) });
        break;
      }
      case 'text':
        if (typeof b.text === 'string' && b.text.trim()) {
          events.push({ ...base, kind: 'text', summary: truncateDetail(b.text.split('\n')[0]), detail: truncateDetail(b.text) });
        }
        break;
    }
  }
  return events;
}

/** 从 stream-json 全量 stdout 取 result 事件（末条 type=result 行） */
export function claudeResultFromStream(stdout: string): Record<string, unknown> | null {
  let result: Record<string, unknown> | null = null;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const e = JSON.parse(trimmed) as Record<string, unknown>;
      if (e.type === 'result') result = e;
    } catch {
      continue;
    }
  }
  return result;
}
