// C2 (2026-06-09): Settings persistence (app data dir に settings.json)
//
// 保存内容:
//   - server_path: kj-trace-server ディレクトリの絶対パス
//   - 将来: window 位置 / theme / auto-start 等

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct Settings {
    #[serde(default)]
    pub server_path: Option<String>,
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("cannot resolve app_data_dir: {}", e))?;
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir app data: {}", e))?;
    Ok(dir.join("settings.json"))
}

#[tauri::command]
pub fn settings_load(app: AppHandle) -> Result<Settings, String> {
    let p = settings_path(&app)?;
    if !p.exists() {
        return Ok(Settings::default());
    }
    let raw = fs::read_to_string(&p).map_err(|e| format!("read settings: {}", e))?;
    let s: Settings = serde_json::from_str(&raw).map_err(|e| format!("parse settings: {}", e))?;
    Ok(s)
}

#[tauri::command]
pub fn settings_save(app: AppHandle, settings: Settings) -> Result<(), String> {
    let p = settings_path(&app)?;
    let body = serde_json::to_string_pretty(&settings).map_err(|e| format!("encode: {}", e))?;
    let mut f = fs::File::create(&p).map_err(|e| format!("create settings: {}", e))?;
    f.write_all(body.as_bytes())
        .map_err(|e| format!("write: {}", e))?;
    Ok(())
}
