# tongbu

> [English](README.en.md)

在多个 CLI 编程 agent 之间**接力同一份工作**的桌面小工具。会话是资产,agent 是可替换的执行器:任何一个 agent 聊不下去、限额用完或想换一家时,把会话内容无缝交接过去,接着干。

![tongbu 主界面](snapshot/app-main.png)

## 用法

**1. 拿到会话 ID** — 在 agent 的终端里,退出时提示的 resume 命令里那串就是会话 ID:

![从终端复制会话 ID](snapshot/source-id.png)

**2. 粘贴进 tongbu** — 自动反查出这个会话属于哪家 agent、在哪个项目目录:

**3. 选择去向** — 点属主卡片直接复制带 `cd` 的原生 resume 命令;想换一家,点对应卡片,内容会被转入那家的新会话,命令自动复制到剪贴板:

![转入其它 agent](snapshot/transfer.png)

**4. 回终端粘贴运行** — 新 agent 带着完整上下文继续工作。对照接力前后，内容一致：

接力前（Claude Code）:

![源会话](snapshot/source_terminal.png)

接力后（Pi）:

![接力成功](snapshot/handoff-terminal.png)

## YOLO 模式

勾选后,复制的命令自动带上各家免确认执行的 flag(如 Claude 的 `--dangerously-skip-permissions`),适合全自动跑长任务:

![YOLO 模式](snapshot/yolo.png)

## 支持的 agent

| Agent | resume 命令 | YOLO flag |
|---|---|---|
| Claude Code | `claude --resume <id>` | `--dangerously-skip-permissions` |
| Codex | `codex resume <id>` | `--dangerously-bypass-approvals-and-sandbox` |
| Kimi | `kimi -r <id>` | `--yolo` |
| Opencode | `opencode -s <id>` | `--auto` |
| Pi | `pi --session <id>` | 默认即是 |

## 安装

发布页提供 macOS(.dmg)、Windows(.exe)、Linux(.deb)安装包。

要求:系统装有 Node.js(反查会话时调用各家 CLI 的原生数据需要),以及你实际使用的那些 agent CLI 已安装登录。

## 隐私

除「转入新会话」会把内容写入目标 agent 的会话文件外,所有操作对各家 agent 的数据**只读**;不读取、不触碰任何登录凭证。

## 开发

```bash
npm install
npm run desktop:dev        # 开发模式起桌面壳
cd desktop && npx tauri build   # 打包当前平台安装包
```

- `src/core/` — 交接引擎与存储(node:sqlite 零依赖,库在 `~/.tongbu/tongbu.db`)
- `src/providers/` — 各家 agent 适配器(读原生会话、写回导入);新增一家 = 新增一个目录 + `registry.ts` 一行
- `desktop/` — Tauri 薄壳(Vite + React + Rust),只调 CLI 的 `--json` 输出,不重写业务逻辑

```bash
npm test               # 单元测试
npm run typecheck      # 类型检查
```
