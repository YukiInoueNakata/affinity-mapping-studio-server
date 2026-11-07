# Affinity Mapping Studio Server (AMS Server)

[Affinity Mapping Studio](https://github.com/YukiInoueNakata/affinity-mapping-studio) の共同編集サーバーです（Yjs + WebSocket）．何人かが同時に同じ親和図を編集でき，部屋ごとの招待・監査ログ・自動スナップショットを備えます．
旧名は kj-trace-server / KJ Studio Server です．

The collaboration server for Affinity Mapping Studio (Yjs + WebSocket), with per-room invitations, audit logs, and automatic snapshots.

## はじめての方へ / Getting started

インストールから，部屋の作成・招待・外からの参加までを画像つきで説明しています．

- [はじめてのガイド（日本語）](docs/getting-started.ja.md)
- [Getting Started (English)](docs/getting-started.en.md)

最短の手順（Node.js 20 以上と，外に公開するなら cloudflared が必要）:

```bash
git clone https://github.com/YukiInoueNakata/affinity-mapping-studio-server.git
cd affinity-mapping-studio-server
npm install
npm run setup     # 初期設定のウィザード（公開方式を選ぶ）
npm start         # app: 1234 / admin: 1235（admin は 127.0.0.1 だけ）
```

起動したら，同じ PC のブラウザで `http://127.0.0.1:1235/admin` を開き，`config/admin-token.txt` の中身を貼ってログインします．部屋の作成・招待・Cloudflare Quick Tunnel の起動は管理画面で行えます．

## できること

- Yjs による同時編集（WebSocket・サブプロトコル `kj-studio.v1`）．参加者の在席表示（Awareness）
- 部屋ごとの接続制御（open / invite_list）と，参加者ごとの招待トークン（有効期限・使用回数・再発行）
- 監査ログ（接続・編集を誰がいつ行ったか）と CSV の書き出し
- 自動スナップショットと，大きな一括変更を検知して直前の状態を保全する仕組み．admin による復元
- 公開方式のプリセット（自分だけ・LAN・Tailscale・Cloudflare Quick/Named Tunnel・reverse-proxy）
- ブラウザの管理画面と管理 CLI（`npm run admin -- <コマンド>`）

## 公開方式（プリセット）

`npm run setup` で選び，`config/server.json` に書かれます．あとから `npm run admin -- preset set <name>` で変えられます（要再起動）．

| プリセット | 使う場面 |
|---|---|
| `local` | 自分の PC だけで試す |
| `lan` | 研究室の LAN の中で使う（IP の制限と組み合わせる） |
| `tailscale-serve` / `tailscale-funnel` | Tailscale の中だけ / Tailscale 経由で公開 |
| `cloudflare-quick` | 一時的な URL で外の人と使う（毎回 URL が変わる．デモ・ゼミ向け） |
| `cloudflare-named` | 独自ドメインの固定 URL で公開（Cloudflare のアカウントと DNS が必要） |
| `reverse-proxy` | nginx・Caddy などの前段で TLS と認証を行う |
| `custom` | 環境変数で個別に組む |

公開系のプリセットでは，メールアドレスの自己申告だけでの接続（旧クライアント向け）は既定で無効です．

## 部屋の種類

監査ログ（off / on）と接続制御（open / invite_list）の組み合わせで決めます．

| 種類 | 監査 | 接続 | 用途 |
|---|---|---|---|
| A. 練習用 | off | open | 自分の PC での試用（外に公開しない） |
| B. 共同分析 | off | invite_list | メンバー限定．記録は不要 |
| C. 記録つき個人作業 | on | open | 自分の作業の記録を残す（外に公開しない） |
| D. 厳格 | on | invite_list | 倫理審査の対象の研究など |

外に公開するときは invite_list にしてください．登録されていない部屋への接続は，既定で拒否します（自動では作りません）．

## 安全のための設計

- 管理用のポート（既定 1235）は `127.0.0.1` だけで待ち受けます．トンネルや公開の対象にしないでください．管理画面と管理 API は管理トークン（Bearer）が必要です．
- 共同編集用のポート（既定 1234）でも `/admin` は拒否します．
- invite_list の部屋は，有効な招待トークンが無い接続を拒否します．
- 秘密と実行時のデータ（`config/admin-token.txt`・`config/server.json`・`data/`）は `.gitignore` 済みです．

## 管理 CLI

```bash
npm run admin -- help
npm run admin -- room create seminar2026 --name "ゼミ 2026" --access invite_list
npm run admin -- invite seminar2026 alice@example.ac.jp --role editor
npm run admin -- url seminar2026 alice@example.ac.jp --host wss://example.trycloudflare.com/
npm run admin -- audit seminar2026 --csv ./audit.csv
npm run admin -- snapshot list seminar2026
```

Windows の PowerShell から `npm run admin -- ...` を呼ぶと，`--name` などのフラグが npm に渡ってしまうことがあります．その場合は `node bin/kj-admin.js <コマンド>` を直接実行してください．

## 接続 URL の形

```
wss://<host>/<roomId>?t=<招待トークン>&nick=<表示名>
```

管理画面の招待の表で「URL」を押すと，この形の招待 URL がコピーされます．

## 開発

```bash
npm test          # vitest
npm run smoke     # 起動して同期・招待・監査を確かめる
```

## 互換性

旧名の時代からのプロトコルの契約は変えていません（サブプロトコル `kj-studio.v1`・IndexedDB のキー `kj-room-<id>`・環境変数 `KJ_*`・`.kjproj`・`doc.getMap('tables')`）．

## ライセンス

Apache License 2.0（[LICENSE](LICENSE)・[NOTICE](NOTICE)）．
