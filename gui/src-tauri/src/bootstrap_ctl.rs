// C6 (2026-06-10): 配布版の同梱物の場所を返し，必要なら初回の npm install を行う．
//
// 2026-11-11: インストーラは server/node_modules まで同梱するので，通常は npm install は走らない．
// 開発時など node_modules が無いときだけ，同梱の Node.js で npm install --omit=dev を行う．
// 場所の解決は paths.rs．

use serde::Serialize;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use tauri::{AppHandle, Emitter};

use crate::paths::{bundled_cloudflared, bundled_node, bundled_server};

#[derive(Serialize, Clone)]
pub struct BundlePaths {
    /// 同梱のサーバ (server/) の絶対パス．無ければ None．
    pub server_path: Option<String>,
    /// bundled node.exe の絶対パス．無ければ None．
    pub node_path: Option<String>,
    /// bundled cloudflared の絶対パス．無ければ None．
    pub cloudflared_path: Option<String>,
    /// node_modules が install されているか
    pub installed: bool,
}

#[derive(Serialize, Clone)]
pub struct SetupLogLine {
    pub stream: String,
    pub line: String,
}

#[derive(Serialize, Clone)]
pub struct SetupResult {
    pub code: i32,
    pub success: bool,
}

#[tauri::command]
pub fn bundle_paths(app: AppHandle) -> BundlePaths {
    let server_path = bundled_server(&app);
    let installed = server_path
        .as_ref()
        .map(|p| p.join("node_modules").exists())
        .unwrap_or(false);
    BundlePaths {
        server_path: server_path.map(|p| p.to_string_lossy().to_string()),
        node_path: bundled_node(&app).map(|p| p.to_string_lossy().to_string()),
        cloudflared_path: bundled_cloudflared(&app).map(|p| p.to_string_lossy().to_string()),
        installed,
    }
}

/// 初回起動 bootstrap: bundled kj-trace-server に npm install --omit=dev．
/// stdout / stderr は "setup:log" event でストリーム．
#[tauri::command]
pub fn bootstrap_install(app: AppHandle) -> Result<SetupResult, String> {
    let paths = bundle_paths(app.clone());
    let server_path = paths
        .server_path
        .ok_or_else(|| "同梱のサーバが見つかりません".to_string())?;
    if paths.installed {
        return Ok(SetupResult {
            code: 0,
            success: true,
        });
    }
    let node_path = paths.node_path.clone();

    // npm-cli.js を直接実行 (npm.cmd は cmd.exe を経由するので CREATE_NO_WINDOW が
    // 効きづらい．node node-runtime/node_modules/npm/bin/npm-cli.js install ... の方が確実)
    let mut npm_cli = PathBuf::from(
        node_path
            .as_ref()
            .ok_or_else(|| "bundled node not found".to_string())?,
    );
    npm_cli.pop(); // node.exe -> dir
    npm_cli.push("node_modules");
    npm_cli.push("npm");
    npm_cli.push("bin");
    npm_cli.push("npm-cli.js");

    let mut cmd = Command::new(node_path.as_ref().unwrap());
    cmd.arg(&npm_cli)
        .args(["install", "--omit=dev", "--no-audit", "--no-fund"])
        .current_dir(&server_path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn npm install: {}", e))?;

    if let Some(stdout) = child.stdout.take() {
        let h = app.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                let _ = h.emit(
                    "setup:log",
                    SetupLogLine {
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
                    "setup:log",
                    SetupLogLine {
                        stream: "stderr".to_string(),
                        line,
                    },
                );
            }
        });
    }

    let status = child.wait().map_err(|e| format!("npm install wait: {}", e))?;
    let code = status.code().unwrap_or(-1);
    Ok(SetupResult {
        code,
        success: code == 0,
    })
}
