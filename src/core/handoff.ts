import type { ProviderAdapter } from '../providers/adapter.js';
import type { SessionRef, TokenUsage, UnifiedTurn } from './types.js';
import type { Chain, Store, SwitchRecord } from './store.js';
import { dedupeCallEvents, mergeTurns, shouldReplacePairedSession, unwrapUserQuery } from './rich.js';
import type { FileDigest } from './atomic.js';
import { addFinding, type Finding } from './findings.js';

/** 写回被阻断（如 TOCTOU 检测到目标被外部修改）：一票否决，不产生部分写 */
export class HandoffBlockedError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'HandoffBlockedError';
  }
}

function turnKey(t: UnifiedTurn): string {
  const callIds = (t.events ?? [])
    .map((e) => e.callId)
    .filter((id): id is string => Boolean(id))
    .join(',');
  return `${t.role}\n${unwrapUserQuery(t.text).trim()}\n${callIds}`;
}

/** 从 source 里去掉 dest 已有的前缀子序列，只留下待追加增量 */
export function diffTurns(source: UnifiedTurn[], dest: UnifiedTurn[]): UnifiedTurn[] {
  let di = 0;
  const out: UnifiedTurn[] = [];
  for (const t of source) {
    const key = turnKey(t);
    let found = -1;
    for (let i = di; i < dest.length; i++) {
      if (turnKey(dest[i]) === key) {
        found = i;
        break;
      }
    }
    if (found >= 0) di = found + 1;
    else out.push(t);
  }
  return out;
}

/** 把 provider 指定会话（缺省取 mtime 最新）接入链：链上该 provider 的绑定替换为该会话 */
export async function adoptIntoChain(
  providerId: string,
  cwd: string,
  adapters: ProviderAdapter[],
  store?: Store | null,
  targetRef?: SessionRef,
  chainId?: string,
): Promise<{ adoptedRef: SessionRef; replacedRef: SessionRef | null; warnings: string[] }> {
  const warnings: string[] = [];
  const adapter = adapters.find((a) => a.id === providerId);
  if (!adapter?.findLatestSession) throw new Error(`未知 provider: ${providerId}`);
  const found = targetRef
    ? { ref: targetRef }
    : await adapter.findLatestSession(cwd);
  if (!found) throw new Error(`${providerId} 未发现可接入的会话`);

  let history: SwitchRecord[] = [];
  if (store) {
    try {
      const id = store.findActiveChain(cwd, chainId)?.id ?? null;
      if (chainId && !id) throw new Error(`找不到链: ${chainId}`);
      history = id ? store.listSwitchEvents(id) : [];
    } catch (error) {
      if (error instanceof Error && /找不到链|已归档/.test(error.message)) throw error;
      history = [];
      warnings.push('链历史读取失败，按无链处理');
    }
  }
  if (history.some((h) => h.toProvider === providerId && h.toRef?.sessionId === found.ref.sessionId)) {
    throw new Error('该会话已在链上，无需接入');
  }

  let replaced: SessionRef | null = pairedRef(history, providerId);
  const otherBound = (() => {
    let r: SessionRef | null = null;
    for (const h of history) {
      if (h.fromProvider !== providerId && h.fromRef) r = h.fromRef;
      if (h.toProvider !== providerId && h.toRef) r = h.toRef;
    }
    return r;
  })();

  if (store) {
    try {
      const id = store.getOrCreateChainSession(cwd, chainId);
      if (!replaced && otherBound) replaced = otherBound;
      store.recordSwitch(id, providerId, replaced, providerId, found.ref);
    } catch (error) {
      console.error('[tongbu] 记录接入失败:', error);
      warnings.push(`链记录失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { adoptedRef: found.ref, replacedRef: replaced, warnings };
}

/**
 * 在链上新建另一侧 agent：从链尾内容交接出一个全新会话并绑定。
 * 约束：必须有链；目标不能是链尾 provider（直接 resume 即可）；每个 provider 在链上只能有一个会话。
 */
export async function createChainSession(
  providerId: string,
  cwd: string,
  adapters: ProviderAdapter[],
  resolve: AdapterResolve,
  store?: Store | null,
  chainId?: string,
): Promise<HandoffResult> {
  if (!store) throw new Error('新建会话需要 store（无法记录链绑定）');
  let history: SwitchRecord[] = [];
  try {
    const id = store.findActiveChain(cwd, chainId)?.id ?? null;
    if (chainId && !id) throw new Error(`找不到链: ${chainId}`);
    history = id ? store.listSwitchEvents(id) : [];
  } catch (error) {
    if (error instanceof Error && /找不到链|已归档/.test(error.message)) throw error;
    history = [];
  }
  if (!history.length) throw new Error('当前目录还没有切换链，请先执行一次 Switch 建链');
  const tail = history.at(-1)!;
  if (tail.toProvider === providerId) {
    throw new Error(`链尾已是 ${providerId}，直接 resume 即可；要开新对话请先切到另一侧`);
  }
  if (pairedRef(history, providerId)) {
    throw new Error(`${providerId} 已在链上（每个 provider 只能有一个会话）；如需更换请用「接入」或先切走`);
  }
  return handoff(providerId, cwd, adapters, resolve, store, { forceNew: true, chainId });
}

/** 链上该 provider 最近一次出现的原生会话（fromRef 或 toRef） */
export function pairedRef(history: SwitchRecord[], provider: string): SessionRef | null {
  let found: SessionRef | null = null;
  for (const h of history) {
    if (h.fromProvider === provider && h.fromRef) found = h.fromRef;
    if (h.toProvider === provider) found = h.toRef;
  }
  return found;
}

export async function chainUsage(
  cwd: string,
  adapters: ProviderAdapter[],
  store?: Store | null,
  chainId?: string,
): Promise<{
  chain: Chain | null;
  total: TokenUsage;
  byProvider: { provider: string; sessionId: string; usage: TokenUsage | null }[];
}> {
  const empty = { inputTokens: 0, outputTokens: 0 };
  if (!store) {
    return { chain: null, total: empty, byProvider: [] };
  }
  const chain = store.findActiveChain(cwd, chainId);
  if (chainId && !chain) throw new Error(`找不到链: ${chainId}`);
  const history = chain ? store.listSwitchEvents(chain.id) : [];
  const byProvider: { provider: string; sessionId: string; usage: TokenUsage | null }[] = [];
  let total = { ...empty };
  for (const adapter of adapters) {
    const ref = pairedRef(history, adapter.id);
    if (!ref || !adapter.sessionUsage) continue;
    let usage: TokenUsage | null = null;
    try {
      usage = await adapter.sessionUsage(ref);
    } catch {
      usage = null;
    }
    byProvider.push({ provider: adapter.id, sessionId: ref.sessionId, usage });
    if (usage) {
      total = {
        inputTokens: total.inputTokens + usage.inputTokens,
        outputTokens: total.outputTokens + usage.outputTokens,
      };
    }
  }
  return { chain, total, byProvider };
}

export type ProviderTip = {
  provider: string;
  ref: SessionRef;
  updatedAt: number;
  onChain?: boolean;
};

export type HandoffResult = {
  newRef: SessionRef;
  resumeCommand: string;
  fromProvider: string;
  turnCount: number;
  /** 链尾已经是目标 provider，没有发生真正的内容交接，调用方直接 resume 即可 */
  alreadyAtTarget?: boolean;
  /** 全部 catch-继续路径的降级披露（recordSwitch/parse/rewrite 失败等） */
  warnings: string[];
  /** 内容处置披露（追加/去重/重写计数） */
  findings: Finding[];
};

export type AdapterResolve = (id: string) => ProviderAdapter | undefined;

export async function collectTips(cwd: string, adapters: ProviderAdapter[]): Promise<ProviderTip[]> {
  const tips: ProviderTip[] = [];
  for (const adapter of adapters) {
    if (!adapter.findLatestSession) continue;
    const found = await adapter.findLatestSession(cwd);
    if (found) tips.push({ provider: adapter.id, ref: found.ref, updatedAt: found.updatedAt });
  }
  return tips;
}

function pickChainTip(tips: ProviderTip[]): ProviderTip | null {
  if (!tips.length) return null;
  return tips.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a));
}

/** 各 provider 最新会话（标记链上绑定）+ 链尾 + store 历史链 */
export async function chainStatus(
  cwd: string,
  adapters: ProviderAdapter[],
  store?: Store | null,
  chainId?: string,
): Promise<{
  tips: ProviderTip[];
  chainTip: ProviderTip | null;
  history: SwitchRecord[];
  chain: Chain | null;
  chains: Chain[];
}> {
  const allTips = await collectTips(cwd, adapters);
  let history: SwitchRecord[] = [];
  let chain: Chain | null = null;
  let chains: Chain[] = [];
  if (store) {
    try {
      chains = store.listChains(cwd);
      chain = store.findActiveChain(cwd, chainId);
      if (chainId && !chain) throw new Error(`找不到链: ${chainId}`);
      history = chain ? store.listSwitchEvents(chain.id) : [];
    } catch (error) {
      if (error instanceof Error && /找不到链/.test(error.message)) throw error;
      history = [];
    }
  }
  // 链尾只以当前链的 switch_events 最后一条为准；不再 fallback 到目录全局最新会话
  let chainTip: ProviderTip | null = null;
  if (history.length) {
    const last = history.at(-1)!;
    chainTip = { provider: last.toProvider, ref: last.toRef, updatedAt: last.createdAt, onChain: true };
  }
  // tips 仍列出同目录全部会话，但用 onChain 标记是否属于当前链；链尾不再 fallback 到游离会话
  const boundIds = new Map<string, Set<string>>();
  for (const h of history) {
    if (h.fromProvider && h.fromRef) {
      boundIds.set(h.fromProvider, (boundIds.get(h.fromProvider) ?? new Set()).add(h.fromRef.sessionId));
    }
    if (h.toRef) {
      boundIds.set(h.toProvider, (boundIds.get(h.toProvider) ?? new Set()).add(h.toRef.sessionId));
    }
  }
  const tips = allTips.map((t) => ({ ...t, onChain: boundIds.get(t.provider)?.has(t.ref.sessionId) ?? false }));
  return { tips, chainTip, history, chain, chains };
}

/** 把链尾会话转换到 targetId，落 switch_events（store 可选）；opts.forceNew 强制新建目标会话（不追加既有配对） */
export async function handoff(
  targetId: string,
  cwd: string,
  adapters: ProviderAdapter[],
  resolve: AdapterResolve,
  store?: Store | null,
  opts?: { forceNew?: boolean; chainId?: string },
): Promise<HandoffResult> {
  const target = resolve(targetId);
  if (!target) throw new Error(`未知 provider: ${targetId}`);
  const warnings: string[] = [];
  const findings: Finding[] = [];

  const tips = await collectTips(cwd, adapters);
  const mtimeTip = pickChainTip(tips);
  if (!mtimeTip) throw new Error('未发现原生会话，请先在 Claude Code 或 Codex TUI 里开聊');

  let history: SwitchRecord[] = [];
  if (store) {
    try {
      const id = store.findActiveChain(cwd, opts?.chainId)?.id ?? null;
      if (opts?.chainId && !id) throw new Error(`找不到链: ${opts.chainId}`);
      history = id ? store.listSwitchEvents(id) : [];
    } catch (error) {
      if (error instanceof Error && /找不到链|已归档/.test(error.message)) throw error;
      history = [];
      warnings.push('链历史读取失败，按无链处理');
    }
  }

  let sourceTip: ProviderTip | null = null;
  let into: SessionRef | undefined;
  let destTurns: UnifiedTurn[] = [];
  let destDigest: FileDigest | null = null;

  // TOCTOU 守卫：dest 解析后若被外部修改（指纹不一致），拒绝写回，避免覆盖外部新内容
  const assertDestUnchanged = async (): Promise<void> => {
    if (!into || !destDigest) return;
    const current = (await target.contentFingerprint?.(into)) ?? null;
    if (!current || current.sha256 !== destDigest.sha256 || current.sizeBytes !== destDigest.sizeBytes) {
      throw new HandoffBlockedError('target_changed', '目标会话正在被外部写入，已中止本次切换，请稍后重试');
    }
  };

  if (history.length > 0) {
    // 链绑定：只认 switch_events 里绑定的会话对，同目录其它会话不串线
    let boundOther: SessionRef | null = null;
    for (const h of history) {
      if (h.fromProvider !== targetId && h.fromRef) boundOther = h.fromRef;
      if (h.toProvider !== targetId && h.toRef) boundOther = h.toRef;
    }
    if (boundOther) {
      sourceTip = { provider: boundOther.provider, ref: boundOther, updatedAt: 0, onChain: true };
      const boundTarget = opts?.forceNew ? null : pairedRef(history, targetId);
      if (boundTarget) {
        try {
          destTurns = await target.parse(boundTarget);
          into = boundTarget;
          destDigest = (await target.contentFingerprint?.(boundTarget)) ?? null;
        } catch {
          into = undefined;
          warnings.push(`目标会话 ${boundTarget.sessionId} 解析失败，改为新建会话承接内容`);
        }
      }
    }
  }

  if (!sourceTip) {
    const other = tips.find((t) => t.provider !== targetId);
    sourceTip = mtimeTip.provider === targetId ? (other ?? null) : mtimeTip;
    if (!sourceTip) {
      // 链尾已在目标 provider。优先使用链上绑定的会话，避免同目录存在多个目标
      // provider 会话时打开到非链尾会话（用户看到的就会是“没有历史”）。
      const boundTarget = pairedRef(history, targetId);
      const resumeRef = boundTarget ?? mtimeTip.ref;
      return {
        newRef: resumeRef,
        resumeCommand: target.resumeCommand(resumeRef),
        fromProvider: targetId,
        turnCount: 0,
        alreadyAtTarget: true,
        warnings,
        findings,
      };
    }
    if (into === undefined && mtimeTip.provider === targetId) {
      try {
        destTurns = await target.parse(mtimeTip.ref);
        into = mtimeTip.ref;
        destDigest = (await target.contentFingerprint?.(mtimeTip.ref)) ?? null;
      } catch {
        into = undefined;
        warnings.push(`目标会话 ${mtimeTip.ref.sessionId} 解析失败，改为新建会话承接内容`);
      }
    }
  }

  const source = resolve(sourceTip.provider);
  if (!source) throw new Error(`链尾 provider 未注册: ${sourceTip.provider}`);

  const turns = await source.parse(sourceTip.ref);
  await target.preflight?.();

  const replace = Boolean(into && shouldReplacePairedSession(turns, destTurns));
  let outgoing = replace ? mergeTurns(turns, destTurns) : into ? diffTurns(turns, destTurns) : turns;
  if (!replace && into) {
    const seen = new Set(
      destTurns.flatMap((t) => (t.events ?? []).map((e) => e.callId).filter((id): id is string => Boolean(id))),
    );
    // 只过滤掉“空文本且全部事件都是已存在的 tool 调用/结果”的回合，
    // 避免把含文本的 assistant turn（其 events 中同时包含 tool_call/tool_result）整轮误删。
    const beforeDedup = outgoing.length;
    outgoing = outgoing.filter((t) => {
      if (t.text.trim()) return true;
      const events = t.events ?? [];
      return events.length === 0 || !events.every((e) => e.callId && seen.has(e.callId));
    });
    const deduped = beforeDedup - outgoing.length;
    if (deduped > 0) addFinding(findings, 'handoff.dedup', 'skipped', deduped);
  }
  if (outgoing.length === 0 && !replace) {
    const resumeRef = into ?? mtimeTip.ref;
    // 目标 session 已包含全部最新内容，无需追加增量；但用户主动切回来时，
    // 仍应把链尾更新为目标 provider，否则桌面端状态会停留在旧 provider。
    // 此外，旧版 tongbu 写出的 Kimi wire.jsonl 可能存在 stepUuid 不匹配等格式
    // 损坏，导致 Kimi 无法识别历史；对已有目标 session 强制 rewrite 可修复。
    if (into) {
      try {
        await assertDestUnchanged();
        await target.importTurns(dedupeCallEvents(turns), cwd, into, { replace: true });
        addFinding(findings, 'handoff.rewrite_only', 'synthesized', 1);
      } catch (error) {
        if (error instanceof HandoffBlockedError) throw error;
        console.error('[tongbu] 重写目标 session 失败，仍尝试 resume:', error);
        warnings.push(`重写目标会话失败，目标内容可能未更新: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (store && sourceTip) {
      try {
        const id = store.getOrCreateChainSession(cwd, opts?.chainId);
        store.recordSwitch(id, sourceTip.provider, sourceTip.ref, targetId, resumeRef);
      } catch (error) {
        console.error('[tongbu] 记录 switch_events 失败，交接仍完成:', error);
        warnings.push(`链记录失败: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return {
      newRef: resumeRef,
      resumeCommand: target.resumeCommand(resumeRef),
      fromProvider: sourceTip?.provider ?? targetId,
      turnCount: 0,
      warnings,
      findings,
    };
  }

  await assertDestUnchanged();
  const newRef = await target.importTurns(dedupeCallEvents(outgoing), cwd, into, replace ? { replace: true } : undefined);
  if (replace) addFinding(findings, 'handoff.rewrite', 'degraded', destTurns.length);
  else addFinding(findings, 'handoff.append', 'exact', outgoing.length);

  if (store) {
    try {
      const id = store.getOrCreateChainSession(cwd, opts?.chainId);
      store.recordSwitch(id, sourceTip.provider, sourceTip.ref, targetId, newRef);
    } catch (error) {
      console.error('[tongbu] 记录 switch_events 失败，交接仍完成:', error);
      warnings.push(`链记录失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    newRef,
    resumeCommand: target.resumeCommand(newRef),
    fromProvider: sourceTip.provider,
    turnCount: outgoing.length,
    warnings,
    findings,
  };
}
