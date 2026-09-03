import { stat } from 'node:fs/promises';
import { diffTurns } from './core/handoff.js';
import { dedupeCallEvents } from './core/rich.js';
import { Store, defaultDbPath } from './core/store.js';
import { IS_WIN, stripDevicePrefix } from './core/platform.js';
import type { SessionRef, TokenUsage, UnifiedTurn } from './core/types.js';
import type { ProviderAdapter } from './providers/adapter.js';
import { getAdapter, listAdapters } from './providers/registry.js';

/** `tongbu open` 的返回协议：桌面 GUI 通过 CLI `--json` 消费 */
export type OpenSessionResult = {
  ok: boolean;
  error?: string;
  provider?: string;
  cwd?: string;
  sessionId?: string;
  filePath?: string;
  cd?: string;
  resumeCommand?: string;
  command?: string;
  mergedTurns?: number;
  /** --from 来源会话的 token 用量（source 支持时才携带；用于跨侧对账展示） */
  sourceUsage?: TokenUsage | null;
  notes?: string[];
};

async function fileExists(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

/** 映射库可用则打开（默认 ~/.tongbu/tongbu.db）；打不开返回 null 降级纯扫描，不阻塞反查 */
function openMappingDb(): Store | null {
  try {
    return new Store(process.env.TONG_DB ?? defaultDbPath());
  } catch {
    return null;
  }
}

/**
 * 按原生 session id 全局反查；providerId 指定时只在对应 provider 里查。
 * store 提供时：先查本地映射表快返（记住的 cwd/filePath 且文件仍在），
 * miss 才全盘扫描各 provider 原生库，命中即写回映射，下次免扫。
 */
export async function resolveById(
  sessionId: string,
  providerId?: string,
  store?: Store | null,
  adapters: ProviderAdapter[] = listAdapters(),
): Promise<{ adapter: ProviderAdapter; found: { ref: SessionRef; updatedAt: number } } | null> {
  const candidates = providerId
    ? ([getAdapter(providerId)].filter((a): a is ProviderAdapter => Boolean(a)) ?? [])
    : adapters.filter((a) => typeof a.findById === 'function');
  if (providerId && !candidates.length) return null;

  if (store) {
    for (const a of candidates) {
      try {
        const loc = store.getSessionLocation(a.id, sessionId);
        // Windows canonicalize 会给路径加 `\\?\` 前缀，探测其去前缀形式
        const filePath = loc && IS_WIN ? stripDevicePrefix(loc.filePath) : loc?.filePath;
        if (loc && filePath && (await fileExists(filePath))) {
          try {
            store.rememberSessionLocation(a.id, loc, Date.now());
          } catch {
            /* 映射刷新失败不影响反查 */
          }
          return {
            adapter: a,
            found: {
              ref: { provider: a.id, sessionId, filePath: loc.filePath, cwd: loc.cwd },
              updatedAt: loc.lastSeenAt,
            },
          };
        }
      } catch {
        /* 映射读失败继续全扫 */
      }
    }
  }

  for (const a of candidates) {
    if (!a.findById) continue;
    try {
      const found = await a.findById(sessionId);
      if (found) {
        if (store) {
          try {
            store.rememberSessionLocation(a.id, found.ref);
          } catch {
            /* 写失败不影响反查 */
          }
        }
        return { adapter: a, found };
      }
    } catch {
      continue;
    }
  }
  return null;
}

/** POSIX 单引号包裹（含单引号转义），供拼接可复制的 cd / command */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** PowerShell 单引号包裹（单引号双写转义），Windows 下拼接可复制的 cd */
export function psQuote(s: string): string {
  return `'${s.replace(/'/g, `''`)}'`;
}

/** 拼接可复制的 cd：isWin=true 用 PowerShell，其它用 POSIX。纯函数供单测两平台 */
export function buildCdFor(cwd: string, isWin: boolean): string {
  return isWin ? `Set-Location -LiteralPath ${psQuote(cwd)}` : `cd ${shellQuote(cwd)}`;
}

/** 拼接可复制的完整命令（cd → resume）。Windows：`;` 分隔；POSIX：`&&` */
export function buildCommandFor(cd: string, resumeCommand: string, isWin: boolean): string {
  return isWin ? `${cd}; ${resumeCommand}` : `${cd} && ${resumeCommand}`;
}

const buildCd = (cwd: string): string => buildCdFor(cwd, IS_WIN);
const buildCommand = (cd: string, resumeCommand: string): string => buildCommandFor(cd, resumeCommand, IS_WIN);

/**
 * 反查 session id 出 cwd 与打开命令；opts.from 指定来源会话时，先把来源增量并入目标会话再输出。
 * 不抛异常，失败以 { ok:false, error } 返回。
 */
export async function openSession(
  targetId: string,
  opts?: { from?: string; provider?: string },
  store?: Store | null,
): Promise<OpenSessionResult> {
  const { from, provider } = opts ?? {};
  const mapping = store ?? openMappingDb();
  const target = await resolveById(targetId, provider, mapping);
  if (!target) {
    return {
      ok: false,
      error: `未找到会话: ${targetId}${provider ? `（provider=${provider}）` : ''}。请确认 id 正确且对应 CLI 已安装登录。`,
    };
  }
  const notes: string[] = [];
  let merged = 0;
  let sourceUsage: TokenUsage | null = null;

  if (from) {
    const source = await resolveById(from, undefined, mapping);
    if (!source) return { ok: false, error: `未找到来源会话: ${from}` };
    try {
      // 来源 usage 聚合携带：source 支持 sessionUsage 时读出，跨侧对账展示（写回各 build 仍为零占位）
      if (typeof source.adapter.sessionUsage === 'function') {
        sourceUsage = (await source.adapter.sessionUsage(source.found.ref).catch(() => null)) ?? null;
        if (sourceUsage) {
          notes.push(
            `来源 ${source.adapter.displayName} 用量 in=${sourceUsage.inputTokens} out=${sourceUsage.outputTokens}（已在对账中携带）`,
          );
        }
      }
      const srcTurns = await source.adapter.parse(source.found.ref);
      const dstTurns = await target.adapter.parse(target.found.ref);
      const outgoing = diffTurns(srcTurns, dstTurns);
      if (outgoing.length === 0) {
        notes.push(`${from} 的内容已全部包含在 ${targetId} 中，无需并入`);
      } else {
        const dedup = dedupeCallEvents(outgoing);
        const newRef = await target.adapter.importTurns(dedup, target.found.ref.cwd, target.found.ref);
        merged = dedup.length;
        notes.push(`已把 ${from} 的 ${merged} 轮新内容并入 ${target.adapter.displayName} 会话 ${newRef.sessionId}`);
        target.found = { ref: newRef, updatedAt: 0 };
      }
    } catch (error) {
      return { ok: false, error: `并入新内容失败: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  const cd = buildCd(target.found.ref.cwd);
  const resumeCommand = target.adapter.resumeCommand(target.found.ref);
  return {
    ok: true,
    provider: target.adapter.id,
    cwd: target.found.ref.cwd,
    sessionId: target.found.ref.sessionId,
    filePath: target.found.ref.filePath,
    cd,
    resumeCommand,
    command: buildCommand(cd, resumeCommand),
    mergedTurns: merged,
    sourceUsage,
    notes,
  };
}

/** 在 cwd 的链记录里找来源会话所属链的另一侧配对会话（取 createdAt 最新）；不在链上返回 null */
function findChainPaired(
  store: Store,
  sourceProvider: string,
  sourceSessionId: string,
  targetProvider: string,
  cwd: string,
): SessionRef | null {
  let pair: SessionRef | null = null;
  let at = -1;
  for (const c of store.listChains(cwd)) {
    for (const h of store.listSwitchEvents(c.id)) {
      const isSource =
        (h.fromProvider === sourceProvider && h.fromRef?.sessionId === sourceSessionId) ||
        (h.toProvider === sourceProvider && h.toRef?.sessionId === sourceSessionId);
      if (!isSource) continue;
      const cand =
        h.fromProvider === targetProvider ? h.fromRef : h.toProvider === targetProvider ? h.toRef : null;
      if (cand && h.createdAt > at) {
        pair = cand;
        at = h.createdAt;
      }
    }
  }
  return pair;
}

/**
 * 把来源会话内容直接转入指定 provider 的会话，返回可 resume 命令。
 * 桌面端点非属主 agent 卡时使用：属性即目标时等价 openSession 快路径，不做转化。
 * 决策顺序：链上配对（来源在链上时回到另一侧）→ 内容已含来源主要部分的既有会话 → 新建。
 * 不抛异常，失败以 { ok:false, error } 返回。
 */
export async function openInProvider(
  sourceId: string,
  providerId: string,
  store?: Store | null,
): Promise<OpenSessionResult> {
  const mapping = store ?? openMappingDb();
  const source = await resolveById(sourceId, undefined, mapping);
  if (!source) return { ok: false, error: `未找到会话: ${sourceId}` };
  const target = getAdapter(providerId);
  if (!target) return { ok: false, error: `未知 provider: ${providerId}` };

  const cwd = source.found.ref.cwd;
  // 属主即目标：无需转化，直接 resume
  if (source.adapter.id === providerId) {
    const resumeCommand = target.resumeCommand(source.found.ref);
    const cd = buildCd(cwd);
    return {
      ok: true,
      provider: providerId,
      cwd,
      sessionId: source.found.ref.sessionId,
      filePath: source.found.ref.filePath,
      cd,
      resumeCommand,
      command: buildCommand(cd, resumeCommand),
      mergedTurns: 0,
      notes: [],
    };
  }

  const notes: string[] = [];
  try {
    await target.preflight?.();
    const turns = await source.adapter.parse(source.found.ref);
    const outgoing = dedupeCallEvents(turns);
    if (outgoing.length === 0) {
      return { ok: false, error: `来源会话 ${sourceId} 没有可转入的内容` };
    }

    // 决策 1：来源在链上 → 回链上另一侧配对会话并并入增量；
// 但目标 provider 的链上「最新配对」不一定对应该输入（同链会分叉出多条线），
// 必须先做内容校验：配对确实承接了来源主要内容（缺失<一半）才落回，否则退到内容匹配。
let merged = 0;
    let newRef: SessionRef | undefined;
    const chainPaired =
      mapping && source.adapter.id !== providerId
        ? findChainPaired(mapping, source.adapter.id, sourceId, providerId, cwd)
        : null;
    let usingChain = false;
    if (chainPaired) {
      const pairTurns = await target.parse(chainPaired);
      const delta = dedupeCallEvents(diffTurns(turns, pairTurns));
      if (delta.length < turns.length / 2) {
        usingChain = true;
        merged = delta.length;
        newRef = delta.length === 0 ? chainPaired : await target.importTurns(delta, cwd, chainPaired);
        notes.push(
          delta.length === 0
            ? `回到链上 ${target.displayName} 会话 ${chainPaired.sessionId}，无需并入`
            : `已把 ${source.adapter.displayName} 的新增 ${delta.length} 轮并入链上 ${target.displayName} 会话 ${chainPaired.sessionId}`,
        );
      }
    }
    if (!usingChain) {
      // 决策 2：游离会话 → 内容匹配复用「包含来源主要部分」的既有目标会话；
      // 取缺失最少且更新时间最新的候选，完全包含直接开回来，部分缺失补增量，找不到才新建。
      let reuse: SessionRef | undefined;
      let reuseMissing = Infinity;
      let reuseAt = -1;
      if (typeof target.listSessions === 'function') {
        try {
          const sessions = await target.listSessions(cwd);
          for (const s of sessions) {
            let destTurns: UnifiedTurn[];
            try {
              destTurns = await target.parse(s.ref);
            } catch {
              continue;
            }
            const missing = diffTurns(turns, destTurns);
            // 缺失少于来源一半才认为同源；多个候选时取缺失最少、更新最新者
            if (
              missing.length < turns.length / 2 &&
              (missing.length < reuseMissing || (missing.length === reuseMissing && s.updatedAt > reuseAt))
            ) {
              reuse = s.ref;
              reuseMissing = missing.length;
              reuseAt = s.updatedAt;
            }
          }
        } catch {
          /* 扫描复用失败回退新建 */
        }
      }
      if (reuse) {
        const delta = dedupeCallEvents(diffTurns(turns, await target.parse(reuse)));
        merged = delta.length;
        newRef = delta.length === 0 ? reuse : await target.importTurns(delta, cwd, reuse);
        notes.push(
          delta.length === 0
            ? `已在 ${target.displayName} 找到包含全部内容的既有会话 ${reuse.sessionId}，直接打开，无需新建`
            : `已把 ${source.adapter.displayName} 的新增 ${delta.length} 轮并入既有 ${target.displayName} 会话 ${reuse.sessionId}`,
        );
      } else {
        merged = outgoing.length;
        newRef = await target.importTurns(outgoing, cwd, undefined);
        notes.push(
          `已把 ${source.adapter.displayName} 的 ${outgoing.length} 轮内容转入 ${target.displayName} 新会话 ${newRef.sessionId}`,
        );
      }
    }
    if (!newRef) return { ok: false, error: '转入目标会话失败: 未获得可用的目标会话引用' };
    const resumeCommand = target.resumeCommand(newRef);
    const cd = buildCd(cwd);
    return {
      ok: true,
      provider: providerId,
      cwd,
      sessionId: newRef.sessionId,
      filePath: newRef.filePath,
      cd,
      resumeCommand,
      command: buildCommand(cd, resumeCommand),
      mergedTurns: merged,
      notes,
    };
  } catch (error) {
    return { ok: false, error: `转入新会话失败: ${error instanceof Error ? error.message : String(error)}` };
  }
}