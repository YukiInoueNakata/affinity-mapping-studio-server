# AMS Server 管理 GUI（gui/）

Affinity Mapping Studio Server を，Node.js や cloudflared を別に入れずに使うためのデスクトップアプリです（Tauri 2）．
インストーラには，サーバ本体・Node.js・cloudflared が入っています．

利用者向けの使い方は [はじめてのガイド](../docs/getting-started.ja.md) を見てください．ここには作りと作り方を書きます．

## できること

| 操作 | 中身 |
|---|---|
| サーバの起動・停止 | 同梱の Node.js で `src/index.js` を動かす．止めるときは先にトンネルを止める |
| ログの表示 | サーバの標準出力・標準エラーを画面に流す |
| Quick Tunnel の起動・停止 | サーバの管理 API（`POST /admin/api/tunnel/start`・`stop`）を呼ぶ．管理画面のボタンと同じ状態になる |
| 管理画面を開く | `http://127.0.0.1:1235/admin` を，管理トークンを入れた状態でブラウザに開く |
| 終了 | アプリを閉じると，トンネルとサーバを止める |

## データの置き場所

インストール先ではなく，利用者のアプリデータのフォルダに置きます．
更新やアンインストールでデータが消えないようにするため，また macOS ではアプリの中に書き込めないためです．

| OS | 場所 |
|---|---|
| Windows | `%APPDATA%\io.github.yukiinouenakata.ams-server\`（`data\` と `config\`） |
| macOS | `~/Library/Application Support/io.github.yukiinouenakata.ams-server/` |

サーバには環境変数で渡します（`KJ_DATA_DIR`・`KJ_CONFIG_DIR`・`KJ_CLOUDFLARED_PATH`）．
公開方式の既定は `cloudflare-quick` です（`KJ_EXPOSURE_PRESET`．`config/server.json` があればそちらが優先）．

## ファイル

| パス | 中身 |
|---|---|
| `src/` | 画面（React + TypeScript） |
| `src-tauri/src/paths.rs` | 同梱物とアプリデータの場所 |
| `src-tauri/src/server_ctl.rs` | サーバのプロセスの起動・停止・ログ |
| `src-tauri/src/tunnel_ctl.rs` | 管理 API を呼んでトンネルを張る・止める |
| `src-tauri/src/runtime_ctl.rs` | `runtime.json` と管理トークンを読む |
| `src-tauri/src/install_ctl.rs` | cloudflared の検出（同梱が無いときの winget での導入） |
| `src-tauri/src/bootstrap_ctl.rs` | 同梱物の場所を返す．node_modules が無いときだけ npm install |
| `scripts/prepare-bundle.mjs` | 同梱物を `resources/` に揃える（版と SHA256 を固定） |
| `resources/` | 同梱物（git に入れない） |

## ビルド

```bash
cd gui
npm ci
node scripts/prepare-bundle.mjs          # 同梱物を揃える（実行している PC の OS 用）
npx tauri build --bundles nsis           # Windows
npx tauri build --bundles dmg            # macOS
```

リリースは GitHub Actions（`.github/workflows/gui-release.yml`）で作ります．
タグ `v*` を push すると，Windows（x64）と macOS（Apple Silicon・Intel）のインストーラを作り，下書きの Release に添付します．

## 署名

コード署名はしていません．Windows では SmartScreen，macOS では Gatekeeper の警告が出ます．越え方はガイドに書いてあります．
