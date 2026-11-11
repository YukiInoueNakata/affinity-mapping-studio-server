// C4 (2026-06-09): data/runtime.json と config/admin-token.txt を読む．
//
// 2026-11-11: 場所はアプリデータのフォルダ (paths.rs)．サーバのフォルダではない．

use serde::Serialize;
use std::fs;
use tauri::AppHandle;

use crate::paths::{admin_port, admin_token, data_dir};

#[derive(Serialize, Default, Clone)]
pub struct CloudflareRuntime {
    pub running: bool,
    pub url: Option<String>,
    pub pid: Option<u32>,
    #[serde(rename = "startedAt")]
    pub started_at: Option<String>,
    pub target: Option<String>,
    #[serde(rename = "targetPort")]
    pub target_port: Option<u32>,
    pub mode: Option<String>,
}

#[derive(Serialize, Default)]
pub struct RuntimeInfo {
    #[serde(rename = "cloudflare")]
    pub cloudflare: CloudflareRuntime,
    #[serde(rename = "writtenAt")]
    pub written_at: Option<String>,
}

#[tauri::command]
pub fn read_runtime(app: AppHandle) -> Result<RuntimeInfo, String> {
    let p = data_dir(&app)?.join("runtime.json");
    if !p.exists() {
        return Ok(RuntimeInfo::default());
    }
    let raw = fs::read_to_string(&p).map_err(|e| format!("read runtime.json: {}", e))?;
    let v: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("parse runtime.json: {}", e))?;
    let cf = v.get("cloudflare").cloned().unwrap_or(serde_json::Value::Null);
    let cloudflare = CloudflareRuntime {
        running: cf.get("running").and_then(|x| x.as_bool()).unwrap_or(false),
        url: cf.get("url").and_then(|x| x.as_str()).map(String::from),
        pid: cf.get("pid").and_then(|x| x.as_u64()).map(|x| x as u32),
        started_at: cf.get("startedAt").and_then(|x| x.as_str()).map(String::from),
        target: cf.get("target").and_then(|x| x.as_str()).map(String::from),
        target_port: cf
            .get("targetPort")
            .and_then(|x| x.as_u64())
            .map(|x| x as u32),
        mode: cf.get("mode").and_then(|x| x.as_str()).map(String::from),
    };
    let written_at = v
        .get("writtenAt")
        .and_then(|x| x.as_str())
        .map(String::from);
    Ok(RuntimeInfo {
        cloudflare,
        written_at,
    })
}

/// C4: 管理トークンを読む (admin URL に #_t= で付ける用)
#[tauri::command]
pub fn read_admin_token(app: AppHandle) -> Result<String, String> {
    admin_token(&app)
}

/// 管理画面の URL を組み立てる．トークンはフラグメントで渡すのでサーバには送られない．
#[tauri::command]
pub fn admin_url(app: AppHandle) -> Result<String, String> {
    let token = admin_token(&app)?;
    Ok(format!("http://127.0.0.1:{}/admin#_t={}", admin_port(&app), token))
}
