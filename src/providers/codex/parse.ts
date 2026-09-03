import { readFile } from 'node:fs/promises';
import {
  ENCRYPTED_THINKING,
  ensureAssistant,
  extractExecCommand,
  flattenToolOutput,
  normalizeUserText,
  pushEvent,
  stripEmptyEvents,
  summarize,
} from '../../core/rich.js';
import type { ProcessEvent, SessionRef, UnifiedTurn } from '../../core/types.js';

/**
 * Codex rollout JSONL → 统一时间线（Rich）：
 * - response_item message：user 过滤内部上下文；assistant 最终回复覆盖 turn.text
 * - reasoning / function_call / custom_tool_call / command_execution 挂到 assistant.events
 * - commentary 作为 text 事件；已有最终回复后的 commentary 丢掉
 * - 整份文件无 response_item message 时，回退 event_msg（旧版 wire，无过程事件）
 * - 坏行/空行跳过；丢弃首条 user 之前的记录
 */
export async function parseCodexSession(ref: SessionRef): Promise<UnifiedTurn[]> {
  const raw = await readFile(ref.filePath, 'utf8');
  const turns: UnifiedTurn[] = [];
  const fallback: UnifiedTurn[] = [];
  let sawUser = false;
  let sawFallbackUser = false;
  let hasResponseMessages = false;
  let lastAssistantIsCommentary = false;

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
    const timestamp = typeof r.timestamp === 'string' ? r.timestamp : '';
    const payload = r.payload;
    if (typeof payload !== 'object' || payload === null) continue;
    const p = payload as Record<string, unknown>;

    if (r.type === 'response_item' && p.type !== 'message') {
      if (!sawUser) continue;
      const events = processItemToEvents(p, timestamp);
      if (!events.length) continue;
      const last = ensureAssistant(turns, timestamp, 'codex');
      for (const ev of events) pushEvent(last, ev);
      continue;
    }

    if (r.type === 'response_item' && p.type === 'message') {
      const role = typeof p.role === 'string' ? p.role : '';
      const text = flattenCodexContent(p.content);
      if (text.trim() === '') continue;
      if (role === 'user') {
        if (isInternalCodexContext(text)) continue;
        const normalized = normalizeUserText(stripCodexRequestWrapper(text));
        if (normalized === null) continue;
        hasResponseMessages = true;
        sawUser = true;
        lastAssistantIsCommentary = false;
        turns.push({ role: 'user', text: normalized, timestamp });
      } else if (role === 'assistant') {
        if (!sawUser) continue;
        const isCommentary = p.phase === 'commentary';
        const last = ensureAssistant(turns, timestamp, 'codex');
        if (isCommentary && last.text && !lastAssistantIsCommentary) {
          continue;
        }
        hasResponseMessages = true;
        last.text = text;
        last.timestamp = timestamp;
        last.provider = 'codex';
        lastAssistantIsCommentary = isCommentary;
      }
      continue;
    }

    if (r.type === 'event_msg') {
      if (p.type === 'user_message' && typeof p.message === 'string') {
        const text = p.message;
        if (text.trim() === '' || isInternalCodexContext(text)) continue;
        const normalized = normalizeUserText(stripCodexRequestWrapper(text));
        if (normalized === null) continue;
        sawFallbackUser = true;
        fallback.push({ role: 'user', text: normalized, timestamp });
      } else if (p.type === 'agent_message' && typeof p.message === 'string') {
        const text = p.message;
        if (!sawFallbackUser || text.trim() === '') continue;
        const last = ensureAssistant(fallback, timestamp, 'codex');
        last.text = text;
        last.timestamp = timestamp;
      }
    }
  }
  return stripEmptyEvents(hasResponseMessages ? turns : fallback);
}

function processItemToEvents(p: Record<string, unknown>, timestamp: string): ProcessEvent[] {
  const base = { timestamp, provider: 'codex' as const };
  switch (p.type) {
    case 'reasoning': {
      const text = reasoningPlaintext(p);
      if (!text) return [];
      return [
        {
          ...base,
          kind: 'thinking',
          summary: text === ENCRYPTED_THINKING ? ENCRYPTED_THINKING : summarize(text, '思考'),
          detail: text,
        },
      ];
    }
    case 'function_call':
    case 'custom_tool_call': {
      const name = typeof p.name === 'string' ? p.name : 'tool';
      const callId = typeof p.call_id === 'string' ? p.call_id : undefined;
      const raw = p.input ?? p.arguments ?? '';
      const rawText = typeof raw === 'string' ? raw : JSON.stringify(raw);
      const detail =
        name === 'exec' || name === 'shell' || name === 'shell_command' ? extractExecCommand(rawText) : rawText;
      return [
        {
          ...base,
          kind: 'tool_call',
          summary: summarize(`${name}: ${detail}`, name),
          detail,
          name,
          callId,
          input: parseToolInput(raw) ?? detail,
        },
      ];
    }
    case 'function_call_output':
    case 'custom_tool_call_output': {
      const callId = typeof p.call_id === 'string' ? p.call_id : undefined;
      const detail = flattenToolOutput(p.output);
      return [{ ...base, kind: 'tool_result', summary: '工具返回', detail, callId }];
    }
    case 'command_execution': {
      const command = typeof p.command === 'string' ? p.command : '';
      const output = typeof p.aggregated_output === 'string' ? p.aggregated_output : '';
      const callId = typeof p.call_id === 'string' ? p.call_id : undefined;
      const events: ProcessEvent[] = [
        {
          ...base,
          kind: 'tool_call',
          summary: summarize(command, 'exec'),
          detail: command,
          name: 'exec',
          callId,
          input: command,
        },
      ];
      if (output.trim()) {
        events.push({ ...base, kind: 'tool_result', summary: '工具返回', detail: output, callId });
      }
      return events;
    }
    // 私有 item 也尽量入账，避免 codex→他侧缺过程：本地 shell 调用 / 网页搜索 / 协作者消息
    case 'local_shell_call': {
      const callId = typeof p.call_id === 'string' ? p.call_id : undefined;
      const shellCommand =
        typeof p.shell_command === 'string' && p.shell_command.trim() ? p.shell_command : '';
      const command = shellCommand || (typeof p.command === 'string' ? p.command : '');
      if (!command.trim()) return [];
      const events: ProcessEvent[] = [
        {
          ...base,
          kind: 'tool_call',
          summary: summarize(command, 'exec'),
          detail: command,
          name: 'exec',
          callId,
          input: command,
        },
      ];
      const output = typeof p.output === 'string' && p.output.trim() ? p.output : '';
      if (output) {
        events.push({ ...base, kind: 'tool_result', summary: '工具返回', detail: output, callId });
      }
      return events;
    }
    case 'web_search_call': {
      const callId = typeof p.call_id === 'string' ? p.call_id : undefined;
      const query = typeof p.query === 'string' ? p.query : '';
      const events: ProcessEvent[] = [
        {
          ...base,
          kind: 'tool_call',
          summary: summarize(query || '网页搜索', 'web_search'),
          detail: query,
          name: 'web_search',
          callId,
          input: { query },
        },
      ];
      const output = typeof p.output === 'string' && p.output.trim() ? p.output : '';
      if (output) {
        events.push({ ...base, kind: 'tool_result', summary: '搜索结果', detail: output, callId });
      }
      return events;
    }
    case 'agent_message': {
      // 协作者/中间消息：不进 turn.text（最终回复由 response_item message 覆盖），只作为中间文本
      const text = flattenCodexContent(p.content);
      if (!text.trim()) return [];
      return [{ ...base, kind: 'text', summary: summarize(text, '过程'), detail: text }];
    }
    default:
      return [];
  }
}

function parseToolInput(raw: unknown): unknown {
  if (raw && typeof raw === 'object') return unwrapLegacyWrappedInput(raw as Record<string, unknown>);
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object')
        return unwrapLegacyWrappedInput(parsed as Record<string, unknown>);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** 兼容历史损坏数据：{input:"{\"file_path\":...}"} → 解出内层对象 */
function unwrapLegacyWrappedInput(obj: Record<string, unknown>): unknown {
  const keys = Object.keys(obj);
  if (keys.length !== 1 || keys[0] !== 'input' || typeof obj.input !== 'string') return obj;
  try {
    const inner: unknown = JSON.parse(obj.input);
    if (inner && typeof inner === 'object') return inner;
  } catch {
    return obj;
  }
  return obj;
}

function reasoningPlaintext(p: Record<string, unknown>): string | null {
  const summary = p.summary;
  if (Array.isArray(summary)) {
    const texts = summary
      .map((item) => {
        if (typeof item === 'string') return item;
        if (typeof item === 'object' && item && typeof (item as { text?: unknown }).text === 'string') {
          return (item as { text: string }).text;
        }
        return '';
      })
      .filter((t) => t.trim() !== '');
    if (texts.length) return texts.join('\n');
  }
  if (typeof p.encrypted_content === 'string' && p.encrypted_content) return ENCRYPTED_THINKING;
  return null;
}

/** content 扁平化（对齐 flatten_codex_content）：string 直取；数组取各项 text，跳过 encrypted_content */
function flattenCodexContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => {
      if (typeof item === 'string') return item;
      if (typeof item !== 'object' || item === null) return '';
      const b = item as Record<string, unknown>;
      if (b.type === 'encrypted_content') return '';
      return typeof b.text === 'string' ? b.text : '';
    })
    .filter((text) => text.trim() !== '')
    .join('\n\n');
}

/** Codex 把 AGENTS.md、环境上下文等内部信息包装成 user 消息，不属于对话（对齐 is_internal_codex_context） */
function isInternalCodexContext(text: string): boolean {
  const trimmed = text.trim();
  const firstLine = (trimmed.split('\n')[0] ?? '').trim().replace(/^#+/, '').trim();
  return (
    (firstLine.startsWith('AGENTS.md instructions') && trimmed.includes('<INSTRUCTIONS>')) ||
    (firstLine === '<environment_context>' && trimmed.includes('</environment_context>')) ||
    (firstLine === '<recommended_plugins>' && trimmed.includes('</recommended_plugins>')) ||
    (firstLine === '<user_instructions>' && trimmed.includes('</user_instructions>'))
  );
}

/** 带附件的用户消息把真实请求包在 `## My request for Codex:` 之后（对齐 strip_codex_request_wrapper） */
function stripCodexRequestWrapper(text: string): string {
  const MARKER = '## My request for Codex:';
  const idx = text.indexOf(MARKER);
  if (idx === -1) return text;
  return text
    .slice(idx + MARKER.length)
    .split('\n')
    .filter((line) => {
      const t = line.trimStart();
      return !t.startsWith('<image') && !t.startsWith('</image');
    })
    .join('\n')
    .trim();
}
