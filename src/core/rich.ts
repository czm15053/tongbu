import type { ProcessEvent, UnifiedTurn } from './types.js';

export const ENCRYPTED_THINKING = '思考中…（加密）';

export function turnHasContent(t: UnifiedTurn): boolean {
  return t.text.trim() !== '' || (t.events?.length ?? 0) > 0;
}

/** 解开 <user_query>...</user_query> 包裹（cc-sessions unwrap_user_query） */
export function unwrapUserQuery(text: string): string {
  const trimmed = text.trim();
  const m = /^<user_query>([\s\S]*)<\/user_query>$/.exec(trimmed);
  const inner = m?.[1]?.trim();
  return inner ? inner : text;
}

/** 判断是否为系统提醒消息（Kimi/Codex 会把 system-reminder 塞进 user prompt） */
export function isSystemReminder(text: string): boolean {
  const trimmed = text.trim();
  return /^<system-reminder>[\s\S]*<\/system-reminder>$/i.test(trimmed);
}

/** 规范化用户消息文本：解包 user_query、过滤 system-reminder */
/** 剥离消息前部的 CLI 注入上下文块（Grok 的 user_info/rules、各家 system-reminder 等），返回剩余正文 */
function stripInjectedBlocks(text: string): string {
  let out = text;
  for (;;) {
    const m = /^\s*<(system-reminder|user_info|rules|environment_details|available_tools)>[\s\S]*?<\/\1>\s*/i.exec(out);
    if (!m) break;
    out = out.slice(m[0].length);
  }
  return out.trim();
}

export function normalizeUserText(text: string): string | null {
  if (isSystemReminder(text)) return null;
  // Grok 真实输入形如 "<user_info>…</user_info>\n\n<rules>…</rules>\n\n<user_query>输入</user_query>"，
  // 先剥前缀注入块再解包，只留用户真正输入
  const unwrapped = unwrapUserQuery(stripInjectedBlocks(text));
  return unwrapped.trim();
}

export function textKey(t: UnifiedTurn): string {
  return `${t.role}\n${unwrapUserQuery(t.text).trim()}`;
}

/**
 * 按文本对齐合并：保留 dest 独有回合，source 过程事件更全则覆盖到对应 dest 回合，
 * 再接上 source 未匹配后缀。
 */
export function mergeTurns(source: UnifiedTurn[], dest: UnifiedTurn[]): UnifiedTurn[] {
  let si = 0;
  const out: UnifiedTurn[] = [];
  for (const d of dest) {
    let found = -1;
    for (let i = si; i < source.length; i++) {
      if (textKey(source[i]!) === textKey(d)) {
        found = i;
        break;
      }
    }
    if (found >= 0) {
      const s = source[found]!;
      out.push((s.events?.length ?? 0) > (d.events?.length ?? 0) ? { ...d, events: s.events } : d);
      si = found + 1;
    } else {
      out.push(d);
    }
  }
  for (let i = si; i < source.length; i++) out.push(source[i]!);
  return out;
}

/** 对齐后的 dest 回合缺 source 的过程事件 → 必须整文件重写，不能追加到最终回复后面 */
export function shouldReplacePairedSession(source: UnifiedTurn[], dest: UnifiedTurn[]): boolean {
  if (dest.length === 0) return false;
  let si = 0;
  for (const d of dest) {
    let found = -1;
    for (let i = si; i < source.length; i++) {
      if (textKey(source[i]!) === textKey(d)) {
        found = i;
        break;
      }
    }
    if (found >= 0) {
      if ((source[found]!.events?.length ?? 0) > (d.events?.length ?? 0)) return true;
      si = found + 1;
    }
  }
  return false;
}

export function toClaudeToolName(name: string): string {
  const n = name.toLowerCase();
  if (n === 'exec' || n === 'shell' || n === 'local_shell' || n === 'shell_command') return 'Bash';
  return name;
}

export function toCodexToolName(name: string): string {
  if (name === 'Bash' || name === 'bash') return 'exec';
  return name;
}

export function flattenToolOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    return output
      .map((item) => {
        if (typeof item === 'string') return item;
        if (typeof item !== 'object' || item === null) return '';
        const o = item as Record<string, unknown>;
        if (typeof o.text === 'string') return o.text;
        if ('content' in o) return flattenToolOutput(o.content);
        return '';
      })
      .join('');
  }
  if (output && typeof output === 'object') return JSON.stringify(output);
  return '';
}

/** 从 Codex exec 脚本里抽出 cmd:"..." */
export function extractExecCommand(input: string): string {
  const cmds: string[] = [];
  const re = /cmd\s*:\s*"((?:\\.|[^"\\])*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input))) {
    cmds.push(m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"'));
  }
  return cmds.length ? cmds.join('\n') : input;
}

export function claudeBashInput(event: ProcessEvent): { command: string; description?: string } {
  const input = event.input;
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const obj = input as Record<string, unknown>;
    if (typeof obj.command === 'string') {
      return {
        command: obj.command,
        description: typeof obj.description === 'string' ? obj.description : event.summary,
      };
    }
  }
  const raw = typeof input === 'string' ? input : (event.detail ?? event.summary);
  return { command: extractExecCommand(raw) };
}

export function codexToolInput(event: ProcessEvent): string {
  if (typeof event.input === 'string') return event.input;
  if (event.input && typeof event.input === 'object' && !Array.isArray(event.input)) {
    const obj = event.input as Record<string, unknown>;
    if (typeof obj.command === 'string') return obj.command;
  }
  return event.detail ?? event.summary;
}

export function summarize(text: string, fallback: string): string {
  const line = text.split('\n').find((l) => l.trim())?.trim() ?? '';
  if (!line) return fallback;
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

/**
 * 合并连续 assistant 轮：部分 provider 的原生模型没有「连续 assistant 轮」概念
 * （grok parse 的 ensureAssistant 会把连续 assistant 行并回上一轮），导入这类目标前
 * 先在时间线侧收敛，否则写回全量、parse 合并导致 round-trip 不对称。
 * 文本按 parse 的拼接约定用空行连接，events 保持先后顺序。
 */
export function mergeConsecutiveAssistant(turns: UnifiedTurn[]): UnifiedTurn[] {
  const out: UnifiedTurn[] = [];
  for (const t of turns) {
    const prev = out.at(-1);
    if (t.role === 'assistant' && prev?.role === 'assistant') {
      prev.text = [prev.text, t.text].filter((s) => s.trim()).join('\n\n');
      if (t.events?.length) prev.events = [...(prev.events ?? []), ...t.events];
    } else {
      out.push({ ...t, events: t.events ? [...t.events] : undefined });
    }
  }
  return out;
}

export function stripEmptyEvents(turns: UnifiedTurn[]): UnifiedTurn[] {
  for (const t of turns) {
    if (t.events && t.events.length === 0) delete t.events;
  }
  return turns;
}

/**
 * 会话级 callId 去重：同一 callId 语义上就是一次调用，只保留首次出现。
 * resume 重放/fork 会让同一调用跨代再现（grok 尤甚，重复还会随链路切换在目标
 * 会话里持续增殖），且「写回全量、parse 去重」会让 round-trip 校验不对称——
 * 因此在导入边界统一收敛，无 callId 的事件不参与。
 */
export function dedupeCallEvents(turns: UnifiedTurn[]): UnifiedTurn[] {
  const seenCalls = new Set<string>();
  const seenResults = new Set<string>();
  return turns.map((t) => {
    if (!t.events?.length) return t;
    let changed = false;
    const kept = t.events.filter((e) => {
      if (e.kind !== 'tool_call' && e.kind !== 'tool_result') return true;
      if (!e.callId) return true;
      const seen = e.kind === 'tool_call' ? seenCalls : seenResults;
      if (seen.has(e.callId)) {
        changed = true;
        return false;
      }
      seen.add(e.callId);
      return true;
    });
    return changed ? { ...t, events: kept } : t;
  });
}

export function ensureAssistant(turns: UnifiedTurn[], timestamp: string, provider: string): UnifiedTurn {
  const last = turns.at(-1);
  if (last?.role === 'assistant') return last;
  const created: UnifiedTurn = { role: 'assistant', text: '', timestamp, provider, events: [] };
  turns.push(created);
  return created;
}

export function pushEvent(turn: UnifiedTurn, event: ProcessEvent): void {
  turn.events = [...(turn.events ?? []), event];
}
