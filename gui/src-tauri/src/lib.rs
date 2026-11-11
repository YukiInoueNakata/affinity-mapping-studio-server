// Affinity Mapping Studio Server 管理 GUI - Tauri 2 backend
//
// Phase C 構成:
//   C1: 雛形 (hello invoke command)
//   C2: server_ctl (node spawn / log stream / settings)
//   C3: tunnel_ctl (cloudflared via kj-admin shim)
//   C4: runtime_ctl (data/runtime.json + admin token read) + admin URL builder
//   R9: install_ctl (cloudflared detect + winget install with live log)

mod bootstrap_ctl;
mod paths;
mod install_ctl;
mod runtime_ctl;
mod server_ctl;
mod settings_ctl;
mod tunnel_ctl;

use serde::Serialize;

#[derive(Serialize)]
struct HelloResponse {
    version: String,
    platform: String,
    arch: String,
}

#[tauri::command]
fn hello() -> HelloResponse {
    HelloResponse {
        version: env!("CARGO_PKG_VERSION").to_string(),
        platform: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(server_ctl::ServerCtl::default())
        .invoke_handler(tauri::generate_handler![
            hello,
            server_ctl::server_status,
            server_ctl::server_start,
            server_ctl::server_stop,
            settings_ctl::settings_load,
            settings_ctl::settings_save,
            runtime_ctl::read_runtime,
            runtime_ctl::read_admin_token,
            runtime_ctl::admin_url,
            tunnel_ctl::tunnel_start,
            tunnel_ctl::tunnel_stop,
            install_ctl::detect_cloudflared,
            install_ctl::install_cloudflared,
            bootstrap_ctl::bundle_paths,
            bootstrap_ctl::bootstrap_install,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // 閉じたときにトンネルとサーバを止める (外に公開されたまま残さない)．
            if let tauri::RunEvent::Exit = event {
                server_ctl::shutdown(app);
            }
        });
}
