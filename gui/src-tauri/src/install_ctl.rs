// R9 (2026-06-09): cloudflared 検出 + winget 経由 install．
//
// 機能:
//   - detect_cloudflared(): PATH + 既知ロケーション (WinGet/brew/apt)
//   - install_cloudflared(): winget install を spawn + stdout/stderr stream
//
// stream は server_ctl と同じパターンで "install:log" event を emit．

use serde::Serialize;
use std::io::BufRead;
use std::io::BufReader;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Clone)]
pub struct InstallLogLine {
    pub stream: String, // "stdout" | "stderr"
    pub line: String,
}

#[derive(Serialize, Clone)]
pub struct InstallResult {
    pub code: i32,
    pub success: bool,
}

#[tauri::command]
pub fn detect_cloudflared(app: AppHandle) -> Option<String> {
    // 0. 同梱の cloudflared (2026-11-11 からインストーラに入れている)
    if let Some(p) = crate::paths::bundled_cloudflared(&app) {
        return Some(p.to_string_lossy().to_string());
    }
    // 1. PATH
    if let Ok(out) = Command::new(if cfg!(target_os = "windows") {
        "where"
    } else {
        "which"
    })
    .arg("cloudflared")
    .stdin(Stdio::null())
    .stderr(Stdio::null())
    .output()
    {
        if out.status.success() {
            let s = String::from_utf8_lossy(&out.stdout)
                .lines()
                .next()
                .unwrap_or("")
                .trim()
                .to_string();
            if !s.is_empty() {
                return Some(s);
            }
        }
    }

    // 2. 既知ロケーション
    let candidates: Vec<PathBuf> = vec![
        #[cfg(target_os = "windows")]
        std::env::var("USERPROFILE").ok().map(|h| {
            PathBuf::from(h)
                .join("AppData")
                .join("Local")
                .join("Microsoft")
                .join("WinGet")
                .join("Packages")
                .join("Cloudflare.cloudflared_Microsoft.Winget.Source_8wekyb3d8bbwe")
                .join("cloudflared.exe")
        }),
        #[cfg(not(target_os = "windows"))]
        Some(PathBuf::from("/opt/homebrew/bin/cloudflared")),
        #[cfg(not(target_os = "windows"))]
        Some(PathBuf::from("/usr/local/bin/cloudflared")),
        #[cfg(not(target_os = "windows"))]
        Some(PathBuf::from("/usr/bin/cloudflared")),
    ]
    .into_iter()
    .flatten()
    .collect();

    for p in candidates {
        if p.exists() {
            return Some(p.to_string_lossy().to_string());
        }
    }
    None
}

#[tauri::command]
pub fn install_cloudflared(app: AppHandle) -> Result<InstallResult, String> {
    // Windows のみ winget で自動 install．Mac/Linux はコマンド表示のみ (UI 側で案内)．
    let (program, args): (&str, Vec<&str>) = if cfg!(target_os = "windows") {
        (
            "winget",
            vec![
                "install",
                "--id",
                "Cloudflare.cloudflared",
                "-e",
                "--silent",
                "--accept-source-agreements",
                "--accept-package-agreements",
            ],
        )
    } else {
        return Err("auto-install は Windows のみ対応．Mac は 'brew install cloudflared' / Linux は 'sudo apt install cloudflared' を手動実行してください．".to_string());
    };

    let mut cmd = Command::new(program);
    cmd.args(&args)
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
        .map_err(|e| format!("failed to spawn {}: {}", program, e))?;

    // stdout / stderr stream
    if let Some(stdout) = child.stdout.take() {
        let h = app.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                let _ = h.emit(
                    "install:log",
                    InstallLogLine {
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
                    "install:log",
                    InstallLogLine {
                        stream: "stderr".to_string(),
                        line,
                    },
                );
            }
        });
    }

    // wait synchronously (this command can take a while; UI shows spinner via event)
    let status = child
        .wait()
        .map_err(|e| format!("install wait failed: {}", e))?;
    let code = status.code().unwrap_or(-1);
    Ok(InstallResult {
        code,
        success: code == 0,
    })
}
