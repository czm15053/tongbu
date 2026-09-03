#!/usr/bin/env node
import { Store, defaultDbPath } from './core/store.js';
import { adoptIntoChain, chainStatus, chainUsage, collectTips, createChainSession, handoff, HandoffBlockedError } from './core/handoff.js';
import { reindexCwd } from './core/search.js';
import type { SessionRef } from './core/types.js';
import { getAdapter, listAdapters } from './providers/registry.js';
import { openInProvider, openSession } from './open.js';

function usage(): never {
  console.error(`用法:
  tongbu status [--json] [--cwd <path>] [--chain <id|name>]
  tongbu switch <provider> [--json] [--cwd <path>] [--chain <id|name>]
  tongbu adopt <provider> [--json] [--cwd <path>] [--chain <id|name>] [--session <id>]
  tongbu sessions [--json] [--cwd <path>] [--chain <id|name>]
  tongbu new <provider> [--json] [--cwd <path>] [--chain <id|name>]
  tongbu chain list|new <name>|rename <id|name> <new>|archive <id|name>|use <id|name> [--json] [--cwd]
  tongbu search <query> [--json] [--cwd <path>]
  tongbu usage [--json] [--cwd <path>] [--chain <id|name>]
  tongbu open <session-id> [--from <session-id>] [--provider <name>] [--to <provider>]  反查 cwd 并输出 cd + 打开命令；带 --from 先并入旧会话；带 --to 把该会话内容转入指定 provider 的新会话`);
  process.exit(1);
}

function fail(json: boolean, message: string): never {
  if (json) console.log(JSON.stringify({ ok: false, error: message }));
  else console.error(message);
  process.exit(1);
}

function openStore(): Store | null {
  try {
    return new Store(process.env.TONG_DB ?? defaultDbPath());
  } catch (error) {
    console.error('[tongbu] 打开数据库失败，以降级无库模式继续:', error);
    return null;
  }
}

function fmtTime(ms: number): string {
  return new Date(ms).toISOString();
}

function parseArgs(argv: string[]): {
  cmd?: string;
  target?: string;
  extra?: string;
  rest: string[];
  json: boolean;
  cwd: string;
  message?: string;
  session?: string;
  chain?: string;
  from?: string;
  provider?: string;
  to?: string;
} {
  const args = argv.slice(2);
  const json = args.includes('--json');
  let cwd = process.cwd();
  let message: string | undefined;
  let session: string | undefined;
  let chain: string | undefined;
  let from: string | undefined;
  let provider: string | undefined;
  let to: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--json') continue;
    if (a === '--cwd') {
      const next = args[++i];
      if (!next) usage();
      cwd = next;
      continue;
    }
    if (a === '--message') {
      message = args[++i];
      continue;
    }
    if (a === '--session') {
      session = args[++i];
      continue;
    }
    if (a === '--chain') {
      chain = args[++i];
      if (!chain) usage();
      continue;
    }
    if (a === '--from') {
      from = args[++i];
      if (!from) usage();
      continue;
    }
    if (a === '--provider') {
      provider = args[++i];
      if (!provider) usage();
      continue;
    }
    if (a === '--to') {
      to = args[++i];
      if (!to) usage();
      continue;
    }
    positional.push(a);
  }
  return {
    cmd: positional[0],
    target: positional[1],
    extra: positional[2],
    rest: positional.slice(2),
    json,
    cwd,
    message,
    session,
    chain,
    from,
    provider,
    to,
  };
}

async function cmdStatus(cwd: string, json: boolean, chain?: string): Promise<void> {
  const store = openStore();
  let result;
  try {
    result = await chainStatus(cwd, listAdapters(), store, chain);
  } catch (error) {
    fail(json, error instanceof Error ? error.message : String(error));
  }
  if (json) {
    console.log(JSON.stringify(result));
    return;
  }
  const { tips, chainTip, history, chain: current } = result;
  if (current) console.log(`链: ${current.name}  (${current.id})`);
  if (!tips.length) {
    console.log('未发现会话（请先在 Claude Code 或 Codex TUI 开聊）');
  } else {
    console.log(`cwd: ${cwd}`);
    console.log('');
    console.log('最新原生会话:');
    for (const tip of tips.sort((a, b) => b.updatedAt - a.updatedAt)) {
      const mark =
        chainTip && tip.provider === chainTip.provider && tip.ref.sessionId === chainTip.ref.sessionId
          ? ' ← 链尾'
          : '';
      const chainMark = tip.onChain ? ' 🔗' : '';
      console.log(`  ${tip.provider.padEnd(8)} ${tip.ref.sessionId}  mtime=${fmtTime(tip.updatedAt)}${chainMark}${mark}`);
      console.log(`           ${tip.ref.filePath}`);
    }
  }
  if (history.length) {
    console.log('');
    console.log('切换链:');
    for (const h of history) {
      const from = h.fromProvider ?? '?';
      console.log(`  ${from} → ${h.toProvider}  (${h.toRef.sessionId})  @ ${fmtTime(h.createdAt)}`);
    }
  } else if (store) {
    console.log('');
    console.log('切换链: （空）');
  }
}

async function cmdSwitch(cwd: string, targetId: string, json: boolean, chain?: string): Promise<void> {
  const store = openStore();
  try {
    const result = await handoff(targetId, cwd, listAdapters(), getAdapter, store, { chainId: chain });
    if (json) {
      console.log(JSON.stringify({ ok: true, ...result }));
      return;
    }
    if (result.alreadyAtTarget) {
      console.log(`链尾已在 ${targetId}，直接打开即可。`);
      console.log(`resume: ${result.resumeCommand}`);
      return;
    }
    console.log(`已从 ${result.fromProvider} 交接 → ${targetId}（${result.turnCount} 轮）`);
    if (result.warnings.length) console.log(`警告: ${result.warnings.join('；')}`);
    console.log(`新会话: ${result.newRef.sessionId}`);
    console.log(`文件:   ${result.newRef.filePath}`);
    console.log('');
    console.log(`resume: ${result.resumeCommand}`);
  } catch (error) {
    if (error instanceof HandoffBlockedError) {
      if (json) console.log(JSON.stringify({ ok: false, error: error.message, blocked: true, code: error.code }));
      else console.error(`[blocked:${error.code}] ${error.message}`);
      process.exit(1);
    }
    const message = error instanceof Error ? error.message : String(error);
    if (json) {
      console.log(JSON.stringify({ ok: false, error: message }));
    } else {
      console.error(message);
    }
    process.exit(1);
  }
}

async function cmdAdopt(
  cwd: string,
  providerId: string,
  json: boolean,
  sessionId?: string,
  chain?: string,
): Promise<void> {
  const store = openStore();
  try {
    let targetRef: SessionRef | undefined;
    if (sessionId) {
      const adapter = listAdapters().find((a) => a.id === providerId);
      if (!adapter?.listSessions) throw new Error(`未知 provider: ${providerId}`);
      const all = await adapter.listSessions(cwd);
      const hit = all.find((s) => s.ref.sessionId === sessionId);
      if (!hit) throw new Error(`在当前目录找不到会话: ${sessionId}`);
      targetRef = hit.ref;
    }
    const result = await adoptIntoChain(providerId, cwd, listAdapters(), store, targetRef, chain);
    if (json) {
      console.log(JSON.stringify({ ok: true, ...result }));
      return;
    }
    console.log(`已接入链: ${result.adoptedRef.sessionId}`);
    if (result.replacedRef) console.log(`替换了:  ${result.replacedRef.sessionId}`);
    if (result.warnings.length) console.log(`警告: ${result.warnings.join('；')}`);
  } catch (error) {
    if (error instanceof HandoffBlockedError) {
      if (json) console.log(JSON.stringify({ ok: false, error: error.message, blocked: true, code: error.code }));
      else console.error(`[blocked:${error.code}] ${error.message}`);
      process.exit(1);
    }
    const message = error instanceof Error ? error.message : String(error);
    if (json) console.log(JSON.stringify({ ok: false, error: message }));
    else console.error(message);
    process.exit(1);
  }
}

/** `tongbu open <id> [--from <id>] [--to <provider>]`：反查 cwd 输出可复制打开命令；--from 先并入目标会话，--to 把该会话转入指定 provider 新会话 */
async function cmdOpen(
  targetId: string,
  json: boolean,
  fromId?: string,
  providerId?: string,
  toId?: string,
): Promise<void> {
  const result = toId
    ? await openInProvider(targetId, toId)
    : await openSession(targetId, { from: fromId, provider: providerId });
  if (!result.ok) {
    fail(json, result.error ?? '未知错误');
  }
  if (json) {
    console.log(JSON.stringify(result));
    return;
  }
  for (const n of result.notes ?? []) console.log(n);
  console.log(result.cd);
  console.log(result.resumeCommand);
}

async function cmdSessions(cwd: string, json: boolean, chain?: string): Promise<void> {
  const adapters = listAdapters();
  const store = openStore();
  // 按链过滤：只显示当前链 switch_events 里绑定过的会话
  const bound = new Map<string, Set<string>>();
  if (store) {
    try {
      const chainRow = chain ? store.findActiveChain(cwd, chain) : store.findActiveChain(cwd);
      if (chainRow) {
        for (const h of store.listSwitchEvents(chainRow.id)) {
          if (h.fromProvider && h.fromRef) {
            bound.set(h.fromProvider, (bound.get(h.fromProvider) ?? new Set()).add(h.fromRef.sessionId));
          }
          if (h.toRef) {
            bound.set(h.toProvider, (bound.get(h.toProvider) ?? new Set()).add(h.toRef.sessionId));
          }
        }
      }
    } catch {
      // 无 store 或链查询失败时退化为全量列表
    }
  }
  const groups = await Promise.all(
    adapters
      .filter((a) => a.listSessions)
      .map(async (a) => {
        const sessions = await a.listSessions!(cwd);
        const ids = bound.get(a.id);
        return {
          provider: a.id,
          sessions: ids ? sessions.filter((s) => ids.has(s.ref.sessionId)) : sessions,
        };
      }),
  );
  const result = groups.filter((g) => g.sessions.length > 0);
  if (json) {
    console.log(JSON.stringify({ cwd, providers: result }));
    return;
  }
  if (!result.length) {
    console.log('未发现会话');
    return;
  }
  for (const g of result) {
    console.log(`${g.provider}:`);
    for (const s of g.sessions) {
      console.log(`  ${s.ref.sessionId}  mtime=${fmtTime(s.updatedAt)}`);
      if (s.preview) console.log(`    ${s.preview}`);
    }
  }
}

async function cmdNew(cwd: string, providerId: string, json: boolean, chain?: string): Promise<void> {
  const store = openStore();
  try {
    let historyLen = 0;
    if (store) {
      const id = store.findActiveChain(cwd, chain)?.id ?? null;
      if (chain && !id) fail(json, `找不到链: ${chain}`);
      historyLen = id ? store.listSwitchEvents(id).length : 0;
    }
    // 空链：优先用 nezha 式 createEmptySession 预创建可 resume 的空会话，
    // 不再 exec 发首条消息；由桌面端 PTY 执行 resume 命令后用户直接在 TUI 交互。
    // 没有 createEmptySession 的 provider 才回退到 start（exec 等首条回复，慢）。
    if (historyLen === 0) {
      const adapter = getAdapter(providerId);
      if (!adapter) fail(json, `未知 provider: ${providerId}`);
      let ref: import('./core/types.js').SessionRef;
      let turnCount = 0;
      if (adapter.createEmptySession) {
        ref = await adapter.createEmptySession(cwd);
      } else if (adapter.start) {
        const started = await adapter.start(cwd, '我们开始吧。');
        ref = started.ref;
        turnCount = 1;
      } else {
        fail(json, `${providerId} 不支持从零开聊`);
      }
      if (store) {
        const id = store.getOrCreateChainSession(cwd, chain);
        // 把首开聊记录为链的起点，后续 handoff 才能正确判断链尾
        store.recordSwitch(id, null, null, providerId, ref);
      }
      const resumeCommand = adapter.resumeCommand(ref);
      if (json) {
        console.log(JSON.stringify({ ok: true, newRef: ref, resumeCommand, turnCount, fromProvider: providerId }));
        return;
      }
      console.log(`新会话: ${ref.sessionId}`);
      console.log(`resume: ${resumeCommand}`);
      return;
    }

    const result = await createChainSession(providerId, cwd, listAdapters(), getAdapter, store, chain);
    if (json) {
      console.log(JSON.stringify({ ok: true, ...result }));
      return;
    }
    console.log(`新会话: ${result.newRef.sessionId}（${result.turnCount} 轮）`);
    console.log(`resume: ${result.resumeCommand}`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (json) console.log(JSON.stringify({ ok: false, error: msg }));
    else console.error(msg);
    process.exit(1);
  }
}

async function cmdChain(cwd: string, json: boolean, action?: string, a?: string, b?: string): Promise<void> {
  const store = openStore();
  if (!store) fail(json, '无法打开数据库');
  try {
    if (!action || action === 'list') {
      const chains = store.listChains(cwd);
      if (json) {
        console.log(JSON.stringify({ ok: true, cwd, chains }));
        return;
      }
      if (!chains.length) {
        console.log('（无链）');
        return;
      }
      for (const c of chains) {
        const mark = c.status === 'archived' ? ' [归档]' : '';
        console.log(`  ${c.name}${mark}  ${c.id}`);
      }
      return;
    }
    if (action === 'new') {
      if (!a) usage();
      const chain = store.createChain(cwd, a);
      if (json) console.log(JSON.stringify({ ok: true, chain }));
      else console.log(`已创建链: ${chain.name}  (${chain.id})`);
      return;
    }
    if (action === 'rename') {
      if (!a || !b) usage();
      const found = store.findActiveChain(cwd, a);
      if (!found) throw new Error(`找不到链: ${a}`);
      const chain = store.renameChain(found.id, b);
      if (json) console.log(JSON.stringify({ ok: true, chain }));
      else console.log(`已重命名: ${chain.name}  (${chain.id})`);
      return;
    }
    if (action === 'archive') {
      if (!a) usage();
      const found = store.findActiveChain(cwd, a);
      if (!found) throw new Error(`找不到链: ${a}`);
      store.archiveChain(found.id);
      if (json) console.log(JSON.stringify({ ok: true, id: found.id }));
      else console.log(`已归档: ${found.name}`);
      return;
    }
    if (action === 'use') {
      if (!a) usage();
      const found = store.findActiveChain(cwd, a);
      if (!found) throw new Error(`找不到链: ${a}`);
      if (found.status === 'archived') throw new Error(`链已归档: ${found.name}`);
      store.touchChain(found.id);
      if (json) console.log(JSON.stringify({ ok: true, chain: { ...found, lastUsedAt: Date.now() } }));
      else console.log(`当前链: ${found.name}  (${found.id})`);
      return;
    }
    usage();
  } catch (error) {
    fail(json, error instanceof Error ? error.message : String(error));
  }
}

async function main(): Promise<void> {
  const { cmd, target, extra, rest, json, cwd, session, chain, from, provider, to } = parseArgs(process.argv);
  if (cmd === 'status') {
    await cmdStatus(cwd, json, chain);
    return;
  }
  if (cmd === 'switch') {
    if (!target) usage();
    await cmdSwitch(cwd, target, json, chain);
    return;
  }
  if (cmd === 'adopt') {
    if (!target) usage();
    await cmdAdopt(cwd, target, json, session, chain);
    return;
  }
  if (cmd === 'sessions') {
    await cmdSessions(cwd, json, chain);
    return;
  }
  if (cmd === 'new') {
    if (!target) usage();
    await cmdNew(cwd, target, json, chain);
    return;
  }
  if (cmd === 'chain') {
    await cmdChain(cwd, json, target, rest[0] ?? extra, rest[1]);
    return;
  }
  if (cmd === 'search') {
    const q = [target, ...rest].filter(Boolean).join(' ');
    if (!q) usage();
    await cmdSearch(cwd, json, q);
    return;
  }
  if (cmd === 'usage') {
    await cmdUsage(cwd, json, chain);
    return;
  }
  if (cmd === 'open') {
    if (!target) usage();
    await cmdOpen(target, json, from, provider, to);
    return;
  }
  usage();
}

async function cmdUsage(cwd: string, json: boolean, chain?: string): Promise<void> {
  const store = openStore();
  try {
    const result = await chainUsage(cwd, listAdapters(), store, chain);
    if (json) {
      console.log(JSON.stringify({ ok: true, ...result }));
      return;
    }
    if (result.chain) {
      console.log(`链: ${result.chain.name}  (${result.chain.id})`);
    } else if (chain) {
      console.log(`链: ${chain}`);
    }
    if (!result.byProvider.length) {
      console.log('无链或该链无绑定会话');
      return;
    }
    console.log(`合计: in=${result.total.inputTokens}  out=${result.total.outputTokens}`);
    console.log('');
    console.log('按会话:');
    for (const item of result.byProvider) {
      const u = item.usage ?? { inputTokens: 0, outputTokens: 0 };
      const note = item.usage === null ? '（无 usage 字段）' : '';
      console.log(
        `  ${item.provider.padEnd(8)} ${item.sessionId.slice(0, 8)}…  in=${u.inputTokens}  out=${u.outputTokens}${note}`,
      );
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (json) {
      console.log(JSON.stringify({ ok: false, error: msg }));
    } else {
      console.error(msg);
    }
    process.exit(1);
  }
}

async function cmdSearch(cwd: string, json: boolean, query: string): Promise<void> {
  const store = openStore();
  if (!store) fail(json, '无法打开数据库');
  try {
    await reindexCwd(cwd, listAdapters(), store);
    const hits = store.searchMessages(query, cwd);
    if (json) {
      console.log(JSON.stringify({ ok: true, query, cwd, hits }));
      return;
    }
    if (!hits.length) {
      console.log('无结果');
      return;
    }
    for (const h of hits) {
      console.log(`${h.provider}  ${h.sessionId}`);
      console.log(`  ${h.snippet.replace(/\s+/g, ' ')}`);
    }
  } catch (error) {
    fail(json, error instanceof Error ? error.message : String(error));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
