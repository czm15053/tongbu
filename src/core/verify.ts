import type { UnifiedTurn } from './types.js';

/**
 * round-trip 自校验：importTurns 写出的内容被自家 parse 反解后，关键内容必须与输入一致。
 * 只比「关键内容」：role 序列、trim 后 text、每 turn 的事件 kind 计数、tool_call 的 callId；
 * 不比 summary/detail 文案，避免展示层调整误伤。
 * - 输入侧先丢弃全空 turn（无文本且无事件）——与各家 builder 的行为对齐
 * - callId：输入侧已定义的必须出现在解析结果中（builder 生成的 id 不要求反向存在）
 */
export function assertRoundTrip(input: UnifiedTurn[], parsed: UnifiedTurn[], provider: string): void {
  const fail = (reason: string): never => {
    throw new Error(`[${provider}] round-trip 校验失败: ${reason}`);
  };

  const wanted = input.filter((t) => t.text.trim() !== '' || (t.events?.length ?? 0) > 0);
  if (wanted.length !== parsed.length) {
    fail(`turn 数不一致，期望 ${wanted.length} 实得 ${parsed.length}`);
  }
  for (let i = 0; i < wanted.length; i++) {
    const w = wanted[i]!;
    const p = parsed[i]!;
    if (w.role !== p.role) fail(`#${i} role 不一致，期望 ${w.role} 实得 ${p.role}`);
    if (w.text.trim() !== p.text.trim()) fail(`#${i} (${w.role}) 文本不一致`);
    for (const kind of ['thinking', 'tool_call', 'tool_result'] as const) {
      const wc = (w.events ?? []).filter((e) => e.kind === kind).length;
      const pc = (p.events ?? []).filter((e) => e.kind === kind).length;
      if (wc !== pc) fail(`#${i} (${w.role}) ${kind} 计数不一致，期望 ${wc} 实得 ${pc}`);
    }
    const wantIds = (w.events ?? []).map((e) => e.callId).filter((id): id is string => Boolean(id));
    const gotIds = new Set((p.events ?? []).map((e) => e.callId).filter((id): id is string => Boolean(id)));
    const missing = wantIds.filter((id) => !gotIds.has(id));
    if (missing.length) fail(`#${i} (${w.role}) 丢失 callId: ${missing.join(', ')}`);
  }
}

/**
 * 写出内容校验器：parse(tmp) 后与输入 turns 对账。
 * 两段式：先全量比对（覆盖 replace 全量重写）；
 * 失败则退化为「从首个 user turn 起的后缀比对」——parse 会丢弃首条 user 之前的
 * assistant 记录，且 grok/pi 的追加是 existing+new 全量重写，全量比对会误报。
 */
export async function verifyWrittenTurns(opts: {
  parse: (filePath: string) => Promise<UnifiedTurn[]>;
  filePath: string;
  turns: UnifiedTurn[];
  provider: string;
  /** 写出侧受控降级的期望变换（如 claude thinking→[思考] 文本）：先变换输入再比对 */
  expect?: (turns: UnifiedTurn[]) => UnifiedTurn[];
}): Promise<void> {
  const expected = opts.expect ? opts.expect(opts.turns) : opts.turns;
  const parsed = await opts.parse(opts.filePath);
  try {
    assertRoundTrip(expected, parsed, opts.provider);
    return;
  } catch {
    // 退化为后缀比对
  }
  const firstUser = expected.findIndex((t) => t.role === 'user');
  if (firstUser < 0) {
    assertRoundTrip(expected, parsed, opts.provider); // 无 user turn：重抛全量差异
  }
  // 遍历全部同名 user 候选起点逐一尝试对齐：grok 等会话含历史重放副本时，
  // 固定取「最后一个匹配」会切出残段误报（append 的旧段里也有同名 user）
  const needle = expected[firstUser]!.text.trim();
  let lastError: Error | null = null;
  for (let i = 0; i < parsed.length; i++) {
    const t = parsed[i]!;
    if (t.role !== 'user' || t.text.trim() !== needle) continue;
    try {
      assertRoundTrip(expected.slice(firstUser), parsed.slice(i), opts.provider);
      return;
    } catch (error) {
      lastError = error as Error;
    }
  }
  if (lastError) throw lastError;
  throw new Error(`[${opts.provider}] round-trip 校验失败: 首条 user 消息未出现在写出的会话中`);
}
