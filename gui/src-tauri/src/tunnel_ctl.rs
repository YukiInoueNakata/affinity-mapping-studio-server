// tunnel_ctl.rs: Cloudflare Quick Tunnel の起動と停止．
//
// 2026-11-11: 以前は node で bin/kj-admin.js tunnel start を呼んでいた．それには 2 つの問題があった．
//   - PC に入っている node を使うので，Node.js の無い PC では動かない．
//   - CLI が自分で cloudflared を起動するため，CLI が終わらず応答が返らない．
//     また，そのトンネルはサーバが知らないので，管理画面の招待 URL のボタンと食い違う．
// 今はサーバの管理 API (POST /admin/api/tunnel/start・stop) を直接呼ぶ．
// 管理画面のボタンで張ったのと同じ状態になる．管理 API は 127.0.0.1 だけで待ち受けている．

use serde::Serialize;
use serde_json::{json, Value};
use std::time::Duration;
use tauri::AppHandle;

use crate::paths::{admin_port, admin_token};

#[derive(Serialize)]
pub struct TunnelResult {
    pub ok: bool,
    pub url: Option<String>,
    pub message: String,
}

/// 管理 API を呼ぶ．2xx 以外は，サーバが返した error の文を添えて Err にする．
pub fn admin_call(app: &AppHandle, method: &str, path: &str, body: Option<Value>) -> Result<Value, String> {
    let token = admin_token(app)?;
    let url = format!("http://127.0.0.1:{}/admin/api{}", admin_port(app), path);
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(60))
        .build();
    let req = agent
        .request(method, &url)
        .set("Authorization", &format!("Bearer {}", token));
    let res = match body {
        Some(b) => req.send_json(b),
        None => req.call(),
    };
    match res {
        Ok(r) => r
            .into_json::<Value>()
            .map_err(|e| format!("管理 API の応答を読めません: {}", e)),
        Err(ureq::Error::Status(code, r)) => {
            let v: Value = r.into_json().unwrap_or(Value::Null);
            let msg = v
                .get("error")
                .and_then(|x| x.as_str())
                .map(String::from)
                .unwrap_or_else(|| v.to_string());
            if code == 401 {
                return Err("管理トークンがサーバと一致しません．".to_string());
            }
            Err(format!("管理 API がエラーを返しました (HTTP {}): {}", code, msg))
        }
        Err(e) => Err(format!(
            "サーバの管理 API に接続できません．サーバが起動しているか確かめてください ({})",
            e
        )),
    }
}

#[tauri::command]
pub fn tunnel_start(app: AppHandle) -> Result<TunnelResult, String> {
    let v = admin_call(&app, "POST", "/tunnel/start", Some(json!({ "target": "app" })))?;
    let url = v.get("url").and_then(|x| x.as_str()).map(String::from);
    if url.is_none() {
        return Err(format!("トンネルの URL が返りませんでした: {}", v));
    }
    Ok(TunnelResult {
        ok: true,
        url: url.clone(),
        message: format!("トンネルを張りました: {}", url.unwrap_or_default()),
    })
}

#[tauri::command]
pub fn tunnel_stop(app: AppHandle) -> Result<TunnelResult, String> {
    let v = admin_call(&app, "POST", "/tunnel/stop", Some(json!({})))?;
    let killed = v.get("killed").and_then(|x| x.as_bool()).unwrap_or(false);
    Ok(TunnelResult {
        ok: true,
        url: None,
        message: if killed {
            "トンネルを止めました．".to_string()
        } else {
            "トンネルは動いていませんでした．".to_string()
        },
    })
}

/// サーバの停止やアプリの終了の前に呼ぶ．失敗しても止めずに理由を返す．
pub fn stop_tunnel_quietly(app: &AppHandle) -> Option<String> {
    admin_call(app, "POST", "/tunnel/stop", Some(json!({}))).err()
}
