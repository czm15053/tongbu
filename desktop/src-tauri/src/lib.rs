// tongbu 桌面壳：极简界面 + 剪贴板复制 + 会话反查 cwd。
// 业务逻辑全部由 src/cli.ts 承担；Rust 侧只提供前端调用 CLI 的桥。
// open <id>（不带 --from）为纯查询：全局反查 cwd / resume，不修改任何会话文件。

use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use tauri::Manager;

/// CLI 运行时根目录（含 src/cli.ts 与 node_modules/tsx）。
/// 开发态 = 仓库根（CARGO_MANIFEST_DIR/../..）；打包态 = 应用 Resources/tongbu-core。
static CORE_ROOT: OnceLock<PathBuf> = OnceLock::new();

fn init_core_root(app: &tauri::App) {
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let root = if dev.join("src/cli.ts").exists() {
        dev
    } else {
        app.path()
            .resource_dir()
            .expect("resource_dir 不可用")
            .join("tongbu-core")
    };
    let _ = CORE_ROOT.set(root);
}

fn repo_root() -> Result<PathBuf, String> {
    CORE_ROOT
        .get()
        .cloned()
        .ok_or_else(|| "核心目录未初始化".to_string())
}

/// node 是否已在 PATH 中可直接执行（Windows 下 OS 会自行解析 node.exe 的位置）
fn node_on_path() -> bool {
    Command::new("node")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// 解析 node 可执行程序名/路径。
/// Windows：优先 PATH（返回 "node" 交给 OS 解析），失败再查固定安装目录；
/// 其它平台：保持 which / Homebrew / nvm 兜底。
fn resolve_node() -> Result<PathBuf, String> {
    if cfg!(target_os = "windows") {
        if node_on_path() {
            return Ok(PathBuf::from("node"));
        }
        let mut cands: Vec<PathBuf> = vec!["C:\\Program Files\\nodejs\\node.exe".into()];
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            cands.push(PathBuf::from(&local).join("Programs\\nodejs\\node.exe"));
        }
        for cand in cands {
            if cand.exists() {
                return Ok(cand);
            }
        }
        return Err("找不到 node，请安装 Node.js 或将其加入 PATH".into());
    }

    if let Ok(out) = Command::new("which").arg("node").output() {
        if out.status.success() {
            let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !p.is_empty() {
                return Ok(PathBuf::from(p));
            }
        }
    }
    for cand in ["/opt/homebrew/bin/node", "/usr/local/bin/node"] {
        if PathBuf::from(cand).exists() {
            return Ok(PathBuf::from(cand));
        }
    }
    let home = std::env::var_os("HOME").map(PathBuf::from).ok_or("无法解析 HOME")?;
    let nvm = home.join(".nvm/versions/node");
    if let Ok(entries) = fs::read_dir(nvm) {
        let mut vers: Vec<PathBuf> = entries.filter_map(|e| e.ok().map(|e| e.path())).collect();
        vers.sort();
        if let Some(bin) = vers
            .into_iter()
            .rev()
            .map(|v| v.join("bin/node"))
            .find(|p| p.exists())
        {
            return Ok(bin);
        }
    }
    Err("找不到 node，请从终端启动 desktop:dev".into())
}

/// GUI 进程不继承用户 shell 的 PATH（macOS launchd 环境只有 /usr/bin:/bin:…），
/// 从 login+interactive shell 取一次真实 PATH 并缓存；失败返回 None 保持现状。
/// Windows 的 GUI 进程继承用户 PATH，无需处理。
fn shell_path() -> Option<&'static str> {
    static PATH: OnceLock<Option<String>> = OnceLock::new();
    PATH.get_or_init(|| {
        if cfg!(target_os = "windows") {
            return None;
        }
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let out = Command::new(shell)
            .args(["-l", "-i", "-c", "echo __TONG_PATH__$PATH"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&out.stdout);
        let p = text
            .lines()
            .find_map(|l| l.strip_prefix("__TONG_PATH__"))?
            .trim()
            .to_string();
        if p.is_empty() { None } else { Some(p) }
    })
    .as_deref()
}

fn run_cli_json(args: &[&str]) -> Result<Value, String> {
    let repo = repo_root()?;
    let cli = repo.join("src/cli.ts");
    if !cli.exists() {
        return Err(format!("找不到 CLI: {}", cli.display()));
    }
    let tsx_entry = repo.join("node_modules/tsx/dist/cli.mjs");
    if !tsx_entry.exists() {
        return Err("仓库根缺少 node_modules，请先 npm install".into());
    }
    let node = resolve_node()?;
    let mut cmd = Command::new(&node);
    cmd.current_dir(&repo).arg(&tsx_entry).arg(&cli).args(args);
    if let Some(path) = shell_path() {
        cmd.env("PATH", path);
    }
    let output = cmd.output().map_err(|e| format!("启动 tsx 失败: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if stdout.is_empty() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("CLI 无输出, exit={}", output.status.code().unwrap_or(-1))
        } else {
            stderr
        });
    }
    serde_json::from_str(stdout.lines().rev().find(|l| l.starts_with('{')).unwrap_or(&stdout))
        .map_err(|e| format!("解析 CLI JSON 失败: {e}"))
}

/// 输入会话 ID，全局反查其 cwd（等价 `tongbu open <id> --json`，只查询不修改）
#[tauri::command]
async fn resolve_cwd(session_id: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || run_cli_json(&["open", session_id.as_str(), "--json"]))
        .await
        .map_err(|e| format!("resolve_cwd 任务失败: {e}"))?
}

/// 把来源会话内容转入目标 provider 新会话（等价 `tongbu open <id> --to <provider> --json`）
#[tauri::command]
async fn open_in(source_id: String, provider_id: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_cli_json(&["open", source_id.as_str(), "--to", provider_id.as_str(), "--json"])
    })
    .await
    .map_err(|e| format!("open_in 任务失败: {e}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            init_core_root(app);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![resolve_cwd, open_in])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}