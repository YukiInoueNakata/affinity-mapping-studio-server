// paths.rs (2026-11-11): 同梱物とアプリデータの場所を 1 か所で決める．
//
// 同梱物 (インストーラに入る．読み取りだけ):
//   <resource_dir>/server        サーバのソースと node_modules
//   <resource_dir>/node-runtime  Node.js (Windows: node.exe / macOS: bin/node)
//   <resource_dir>/cloudflared   cloudflared (Windows: cloudflared.exe / macOS: cloudflared)
//   開発時 (tauri dev) は gui/resources/ の同じ名前を使う．
//
// アプリデータ (利用者ごと．書き込む):
//   <app_data_dir>/data    部屋のデータ・監査ログ・スナップショット・runtime.json
//   <app_data_dir>/config  server.json・admin-token.txt
//   インストール先に置くと，更新やアンインストールでデータが消え，macOS ではアプリの中に書けないため．
//   サーバには KJ_DATA_DIR・KJ_CONFIG_DIR で渡す．

use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

fn dev_resource_root() -> Option<PathBuf> {
    // CARGO_MANIFEST_DIR (src-tauri) / .. / resources
    let manifest = option_env!("CARGO_MANIFEST_DIR")?;
    PathBuf::from(manifest).join("..").join("resources").canonicalize().ok()
}

/// Windows の長いパスの印 (\\?\) を外す．表示が分かりにくく，子プロセスの cwd にも要らないため．
/// ネットワークのパス (\\?\UNC\...) はそのままにする．
fn clean(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy().to_string();
    match s.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with(r"UNC\") => PathBuf::from(rest),
        _ => p,
    }
}

/// 同梱物を探す．release は resource_dir，開発時は gui/resources．
pub fn bundled<P: AsRef<Path>>(app: &AppHandle, sub: P) -> Option<PathBuf> {
    if let Ok(d) = app.path().resource_dir() {
        let p = clean(d.join(&sub));
        if p.exists() {
            return Some(p);
        }
    }
    if cfg!(debug_assertions) {
        if let Some(root) = dev_resource_root() {
            let p = root.join(&sub);
            if p.exists() {
                return Some(p);
            }
        }
    }
    None
}

pub fn bundled_server(app: &AppHandle) -> Option<PathBuf> {
    bundled(app, "server")
}

pub fn bundled_node(app: &AppHandle) -> Option<PathBuf> {
    if cfg!(target_os = "windows") {
        bundled(app, "node-runtime/node.exe")
    } else {
        bundled(app, "node-runtime/bin/node")
    }
}

pub fn bundled_cloudflared(app: &AppHandle) -> Option<PathBuf> {
    if cfg!(target_os = "windows") {
        bundled(app, "cloudflared/cloudflared.exe")
    } else {
        bundled(app, "cloudflared/cloudflared")
    }
}

fn app_sub_dir(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("アプリデータのフォルダが分かりません: {}", e))?;
    let p = base.join(name);
    fs::create_dir_all(&p).map_err(|e| format!("フォルダを作れません ({}): {}", p.display(), e))?;
    Ok(p)
}

pub fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app_sub_dir(app, "data")
}

pub fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app_sub_dir(app, "config")
}

/// 管理ポート．config/server.json の network.adminPort があればそれ，無ければ 1235．
pub fn admin_port(app: &AppHandle) -> u16 {
    let read = || -> Option<u16> {
        let p = config_dir(app).ok()?.join("server.json");
        let raw = fs::read_to_string(p).ok()?;
        let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
        v.get("network")?.get("adminPort")?.as_u64().map(|x| x as u16)
    };
    read().unwrap_or(1235)
}

/// 管理トークン (config/admin-token.txt)．サーバの初回起動で作られる．
pub fn admin_token(app: &AppHandle) -> Result<String, String> {
    let p = config_dir(app)?.join("admin-token.txt");
    let raw = fs::read_to_string(&p).map_err(|_| {
        format!(
            "管理トークンがまだありません ({})．サーバを一度起動すると作られます．",
            p.display()
        )
    })?;
    let t = raw.trim().to_string();
    if t.is_empty() {
        return Err(format!("管理トークンが空です ({})", p.display()));
    }
    Ok(t)
}
