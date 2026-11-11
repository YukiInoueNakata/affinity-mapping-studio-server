// C2 (2026-06-09): サーバ (node) のプロセス制御．
//
// 機能:
//   - spawn_server({server_path}): node src/index.js を spawn
//   - stop_server(): SIGTERM → 5s wait → kill (Win では taskkill /T で子ごと)
//   - is_running(): bool
//   - get_status(): { running, pid, started_at }
//
// stdout/stderr stream:
//   - 別 thread で読んで Tauri AppHandle 経由で "server:log" event を emit
//   - 終了したら "server:status" event を emit
//
// 注意:
//   - 1 プロセスのみ管理 (多重起動防止)
//   - app close 時の cleanup は呼び出し側で stop_server() する

use serde::Serialize;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::paths::{bundled_cloudflared, bundled_node, config_dir, data_dir};
use crate::tunnel_ctl::stop_tunnel_quietly;

#[derive(Default)]
pub struct ServerCtl {
    inner: Mutex<Option<RunningServer>>,
}

struct RunningServer {
    child: Child,
    started_at: u64, // unix epoch sec
    server_path: String,
}

#[derive(Serialize, Clone)]
pub struct ServerStatus {
    pub running: bool,
    pub pid: Option<u32>,
    pub started_at: Option<u64>,
    pub server_path: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct LogLine {
    pub stream: String, // "stdout" | "stderr"
    pub line: String,
}

#[tauri::command]
pub fn server_status(state: State<'_, ServerCtl>) -> ServerStatus {
    let guard = state.inner.lock().unwrap();
    match guard.as_ref() {
        Some(s) => ServerStatus {
            running: true,
            pid: Some(s.child.id()),
            started_at: Some(s.started_at),
            server_path: Some(s.server_path.clone()),
        },
        None => ServerStatus {
            running: false,
            pid: None,
            started_at: None,
            server_path: None,
        },
    }
}

#[tauri::command]
pub fn server_start(
    server_path: String,
    state: State<'_, ServerCtl>,
    app: AppHandle,
) -> Result<ServerStatus, String> {
    let mut guard = state.inner.lock().unwrap();
    if guard.is_some() {
        return Err("already running".to_string());
    }

    // 配布版は同梱の Node.js だけを使う (利用者の PC に Node.js が無くても動くように)．
    // 同梱が無いのに PC の node へ黙って切り替えると，版の違いで動きが変わるので，開発時だけ許す．
    let node_bin = match bundled_node(&app) {
        Some(p) => p.to_string_lossy().to_string(),
        None if cfg!(debug_assertions) => "node".to_string(),
        None => return Err("同梱の Node.js が見つかりません．インストールし直してください．".to_string()),
    };

    // データと設定はアプリデータのフォルダに置く (paths.rs)．
    let data = data_dir(&app)?;
    let config = config_dir(&app)?;

    let mut cmd = Command::new(&node_bin);
    cmd.arg("src/index.js")
        .current_dir(&server_path)
        .env("KJ_DATA_DIR", &data)
        .env("KJ_CONFIG_DIR", &config)
        // 公開方式の既定は Cloudflare Quick Tunnel．config/server.json があればそちらが優先される．
        // 公開系の preset では，サーバが localhostAuto などの緩い認証を強制的に切る．
        .env("KJ_EXPOSURE_PRESET", "cloudflare-quick")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());

    // Windows: 子コンソールを隠す
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    if let Some(cf) = bundled_cloudflared(&app) {
        cmd.env("KJ_CLOUDFLARED_PATH", cf);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn node: {}. Path: {}", e, server_path))?;

    let pid = child.id();
    let started_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    // stdout / stderr stream → Tauri event
    if let Some(stdout) = child.stdout.take() {
        let h = app.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                let _ = h.emit(
                    "server:log",
                    LogLine {
                        stream: "stdout".to_string(),
                        line,
                    },
                );
            }
        });
    }
    if let Some(stderr) = child.stderr.take() {
        let h = app.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                let _ = h.emit(
                    "server:log",
                    LogLine {
                        stream: "stderr".to_string(),
                        line,
                    },
                );
            }
        });
    }

    *guard = Some(RunningServer {
        child,
        started_at,
        server_path: server_path.clone(),
    });

    let status = ServerStatus {
        running: true,
        pid: Some(pid),
        started_at: Some(started_at),
        server_path: Some(server_path),
    };
    let _ = app.emit("server:status", &status);
    Ok(status)
}

#[tauri::command]
pub fn server_stop(state: State<'_, ServerCtl>, app: AppHandle) -> Result<ServerStatus, String> {
    let mut guard = state.inner.lock().unwrap();
    let mut running = match guard.take() {
        Some(s) => s,
        None => return Err("not running".to_string()),
    };

    // 先にトンネルを止める．macOS では node を止めても子の cloudflared が残るため．
    if let Some(e) = stop_tunnel_quietly(&app) {
        let _ = app.emit(
            "server:log",
            LogLine {
                stream: "stderr".to_string(),
                line: format!("[gui] トンネルを止められませんでした (サーバは止めます): {}", e),
            },
        );
    }

    // graceful (Win: taskkill /T で子ごと / Unix: SIGTERM)
    #[cfg(target_os = "windows")]
    {
        let pid = running.child.id();
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = running.child.kill();
    }

    let _ = running.child.wait();

    let status = ServerStatus {
        running: false,
        pid: None,
        started_at: None,
        server_path: None,
    };
    let _ = app.emit("server:status", &status);
    Ok(status)
}

/// アプリの終了時に呼ぶ．トンネルを止めてからサーバを止める．
/// これが無いと，アプリを閉じても node と cloudflared が残り，外に公開されたままになる．
pub fn shutdown(app: &AppHandle) {
    let state = app.state::<ServerCtl>();
    let mut guard = match state.inner.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    let Some(mut running) = guard.take() else { return };
    let _ = stop_tunnel_quietly(app);
    #[cfg(target_os = "windows")]
    {
        let pid = running.child.id();
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = running.child.kill();
    }
    let _ = running.child.wait();
}
