import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import "./App.css";

type Agent = {
  id: string;
  label: string;
  command: (id: string) => string;
  /** YOLO 模式 flag（实测自各 CLI --help）；undefined = 该 agent 默认即此（如 Pi） */
  yolo?: string;
};

// 注:grok 已从启动器移除（CLI grok resume 打开不正常）；tongbu switch/adopt 仍支持 grok
const AGENTS: Agent[] = [
  { id: "claude", label: "Claude", command: (id) => `claude --resume ${id}`, yolo: "--dangerously-skip-permissions" },
  { id: "codex", label: "Codex", command: (id) => `codex resume ${id}`, yolo: "--dangerously-bypass-approvals-and-sandbox" },
  { id: "kimi", label: "Kimi", command: (id) => `kimi -r ${id}`, yolo: "--yolo" },
  { id: "opencode", label: "Opencode", command: (id) => `opencode -s ${id}`, yolo: "--auto" },
  { id: "pi", label: "Pi", command: (id) => `pi --session ${id}` },
];

type Detect =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ok"; cwd: string; provider: string | null }
  | { status: "err"; error: string };

const PROV_LABELS = Object.fromEntries(AGENTS.map((a) => [a.id, a.label])) as Record<string, string>;

/** 是否 Tauri 环境：浏览器预览（headless 截图/直开页面）无 __TAURI_INTERNALS__ */
function hasTauri() {
  return "__TAURI_INTERNALS__" in window && Boolean((window as unknown as Record<string, unknown>).__TAURI_INTERNALS__);
}

/** 运行平台：Windows 用 PowerShell 语法，其它保持 POSIX */
const IS_WIN =
  typeof navigator !== "undefined" && /windows/i.test(navigator.userAgent + " " + (navigator.platform ?? ""));

/** POSIX 单引号包裹（含单引号转义），拼接可粘贴的 cd 路径 */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** PowerShell 单引号包裹（单引号双写转义）*/
function psQuote(s: string): string {
  return `'${s.replace(/'/g, `''`)}'`;
}

/** 完整命令：cd（识别到路径时）→ agent 原生 resume → yolo flag（勾选且支持时） */
function buildCommand(agent: Agent, id: string, cwd: string | undefined, yolo: boolean): string {
  let cmd = agent.command(id);
  if (yolo && agent.yolo) cmd = `${cmd} ${agent.yolo}`;
  if (!cwd) return cmd;
  return IS_WIN ? `Set-Location -LiteralPath ${psQuote(cwd)}; ${cmd}` : `cd ${shellQuote(cwd)} && ${cmd}`;
}

export default function App() {
  /** 已知卡片 provider 集合（owner 为已下架 provider 如 grok 时不锁任何卡） */
  const KNOWN = new Set(AGENTS.map((a) => a.id));
  const [sessionId, setSessionId] = useState(
    () => new URLSearchParams(window.location.search).get("session") ?? "",
  );
  const [yolo, setYolo] = useState(false);
  const [detect, setDetect] = useState<Detect>({ status: "idle" });
  const [copiedTo, setCopiedTo] = useState<string | null>(null);
  /** 正在把会话转入哪个 agent（非属主卡点击后的等待态） */
  const [busy, setBusy] = useState<string | null>(null);
  /** 转入结果或错误提示 */
  const [notice, setNotice] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const id = sessionId.trim();
  const valid = id.length > 0;

  /** 会话反查成功时知道属主（如 claude），其它 agent 走「转入新会话」；识别失败时为 null 保持全部直接复制 */
  const owner = detect.status === "ok" ? detect.provider : null;
  const ownerLabel = () => (owner ? (PROV_LABELS[owner] ?? owner) : "");

  // 输入会话 ID 后自动反查 cwd（等价 `tongbu open <id> --json`，只读不修改会话）
  useEffect(() => {
    if (!valid) {
      setDetect({ status: "idle" });
      return;
    }
    if (!hasTauri()) {
      setDetect({ status: "err", error: "浏览器预览环境，无法自动识别路径" });
      return;
    }
    setDetect({ status: "loading" });
    let cancelled = false;
    const t = window.setTimeout(() => {
      invoke("resolve_cwd", { sessionId: id })
        .then((v) => {
          if (cancelled) return;
          const data = v as { ok?: boolean; cwd?: string; provider?: string; error?: string };
          setDetect(
            data.ok
              ? { status: "ok", cwd: data.cwd ?? "", provider: data.provider ?? null }
              : { status: "err", error: data.error ?? "未找到会话" },
          );
        })
        .catch((e) => {
          if (!cancelled) setDetect({ status: "err", error: String(e) });
        });
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [id, valid]);

  async function copyText(text: string) {
    try {
      await writeText(text);
    } catch {
      // 浏览器预览兜底：Tauri 剪贴板不可用时走 Web API
      await navigator.clipboard.writeText(text);
    }
  }

  async function copy(agent: Agent) {
    if (!valid) return;
    // 属主卡：直接复制原生 resume id（识别失败时也允许用户自决）
    if (owner && owner !== agent.id) return;
    const cwd = detect.status === "ok" ? detect.cwd : undefined;
    const text = buildCommand(agent, id, cwd, yolo);
    await copyText(text);
    setCopiedTo(agent.id);
    window.setTimeout(() => setCopiedTo((cur) => (cur === agent.id ? null : cur)), 2000);
  }

  /** 非属主卡：把来源会话内容转入该 provider 的新会话，再复制其 resume 命令 */
  async function convert(agent: Agent) {
    if (!valid || !owner) return;
    setBusy(agent.id);
    setNotice(null);
    try {
      const r = (await invoke("open_in", { sourceId: id, providerId: agent.id })) as {
        ok?: boolean;
        error?: string;
        cwd?: string;
        sessionId?: string;
        mergedTurns?: number;
        notes?: string[];
      };
      if (!r.ok || !r.sessionId) throw new Error(r.error ?? "转入失败");
      await copyText(buildCommand(agent, r.sessionId, r.cwd ?? undefined, yolo));
      setNotice({
        type: "ok",
        text: `${r.notes?.[0] ?? `已转入 ${agent.label} 会话 ${r.sessionId}`}，命令已复制`,
      });
    } catch (e) {
      setNotice({ type: "err", text: String(e instanceof Error ? e.message : e) });
    } finally {
      setBusy(null);
    }
  }

  const grid = (enabled: boolean) =>
    AGENTS.map((agent) => {
      const cmd = buildCommand(agent, id, detect.status === "ok" ? detect.cwd : undefined, yolo);
      const done = enabled && copiedTo === agent.id;
      const converting = busy === agent.id;
      // 属主已识别时，属主卡直接复制；其它卡点击即转入该 agent 的新会话
      // owner 是已下架 provider（如 grok，无对应卡）时不锁定，避免整个 grid 灰掉
      const notOwner = enabled && owner !== null && owner !== agent.id && KNOWN.has(owner);
      const clickable = enabled && !converting;
      return (
        <button
          key={agent.id}
          type="button"
          className={`agent-card ${agent.id}${done ? " done" : ""}${notOwner ? " foreign" : ""}${converting ? " busy" : ""}${yolo && agent.yolo ? " yolo" : ""}`}
          disabled={!clickable}
          onClick={clickable ? (notOwner ? () => void convert(agent) : () => void copy(agent)) : undefined}
          title={notOwner ? `此 id 属于 ${ownerLabel()}；点击把会话内容转入 ${agent.label} 新会话` : cmd}
        >
          <span className="agent-head">
            <img className="agent-logo" src={`/${agent.id}.svg`} alt={agent.label} />
            <span className="agent-name">{agent.label}</span>
            {yolo && agent.yolo && <span className="yolo-badge">YOLO</span>}
          </span>
          <span className={`agent-action${done ? " done" : ""}`}>
            {converting ? "转入中…" : done ? "✓ 已复制" : notOwner ? "点击转入新会话" : "点按复制命令"}
          </span>
        </button>
      );
    });

  return (
    <div className="app">
      <header className="title">tongbu</header>
      <p className="hint">粘贴会话 ID，自动识别项目路径，选择 agent 复制带 cd 的原生 resume 命令，回到对应终端粘贴运行</p>

      <div className="field">
        <span className="field-lead">❯</span>
        <input
          className="session-input"
          value={sessionId}
          autoFocus
          placeholder="会话 ID（如 msg_ / ses_ / …）"
          onChange={(e) => setSessionId(e.target.value)}
          spellCheck={false}
        />
      </div>

      {detect.status === "loading" && <div className="detect detecting">识别路径中…</div>}
      {detect.status === "ok" && (
        <div className="detect ok">
          <span>✓</span> {detect.cwd}
        </div>
      )}
      {detect.status === "err" && (
        <div className="detect err">
          <span>⚠</span> {detect.error}（可复制不带 cd 的命令）
        </div>
      )}

      <label className="yolo-row" title="跳过本 agent 的权限确认（危险）">
        <input type="checkbox" checked={yolo} onChange={(e) => setYolo(e.target.checked)} />
        <span className="yolo-switch" />
        <span className="yolo-label">YOLO 模式</span>
        <span className="yolo-note">跳过权限确认，自动执行所有工具</span>
      </label>

      {notice && <div className={`detect ${notice.type}`}><span>{notice.type === "ok" ? "✓" : "⚠"}</span> {notice.text}</div>}

      <div className={`agent-grid${valid ? "" : " disabled"}`}>{grid(valid)}</div>
    </div>
  );
}