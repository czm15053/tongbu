import type { ProcessEvent } from '../../core/types.js';
import { truncateDetail } from '../claude/events.js';

const stamp = (): string => new Date().toISOString();

/**
 * codex exec --json 一行 → 过程事件（仅展示）：
 * - item.completed：reasoning（加密 → 占位）/ function_call / function_call_output
 *   / command_execution（新版 shell 工具：一条 completed 同时产 tool_call + tool_result）
 *   / commentary agent_message
 * - 最终回复型 agent_message（非 commentary）不产事件（避免与最终回复重复）
 * - thread.started / turn.* / error 行不产事件（错误由调用方错误路径处理）
 */
export function codexLineToProcessEvents(line: string): ProcessEvent[] {
  let e: Record<string, unknown>;
  try {
    e = JSON.parse(line);
  } catch {
    return [];
  }
  if (e.type !== 'item.completed') return [];
  const item = e.item as Record<string, unknown> | undefined;
  if (!item || typeof item.type !== 'string') return [];
  const base = { timestamp: stamp(), provider: 'codex' };

  switch (item.type) {
    case 'reasoning': {
      const text = typeof item.text === 'string' ? item.text : '';
      return [
        {
          ...base,
          kind: 'thinking',
          summary: text ? `思考: ${text.split('\n')[0].slice(0, 80)}` : '思考中…（加密）',
          detail: text ? truncateDetail(text) : undefined,
        },
      ];
    }
    case 'function_call':
    case 'custom_tool_call': {
      const name = typeof item.name === 'string' ? item.name : 'tool';
      const args = typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? '');
      return [{ ...base, kind: 'tool_call', summary: `${name}: ${truncateDetail(args).split('\n')[0]}`, detail: truncateDetail(args) }];
    }
    case 'function_call_output':
    case 'custom_tool_call_output': {
      const out = typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '');
      return [{ ...base, kind: 'tool_result', summary: '工具返回', detail: truncateDetail(out) }];
    }
    case 'command_execution': {
      // 新版 codex 的 shell 工具：completed 时命令与输出同条到达，拆成调用 + 返回两事件
      const command = typeof item.command === 'string' ? item.command : '';
      const output = typeof item.aggregated_output === 'string' ? item.aggregated_output : '';
      const events: ProcessEvent[] = [
        { ...base, kind: 'tool_call', summary: `shell: ${command}`, detail: truncateDetail(command) },
      ];
      if (output.trim()) {
        events.push({ ...base, kind: 'tool_result', summary: '工具返回', detail: truncateDetail(output) });
      }
      return events;
    }
    case 'agent_message': {
      // 仅 commentary 中间说明作为过程事件；final_answer 由最终回复呈现
      if (item.phase === 'commentary' && typeof item.text === 'string' && item.text.trim()) {
        return [{ ...base, kind: 'text', summary: truncateDetail(item.text.split('\n')[0]), detail: truncateDetail(item.text) }];
      }
      return [];
    }
    default:
      return [];
  }
}
