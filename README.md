# Affinity Mapping Studio Server (AMS Server，旧名: kj-trace-server / KJ Studio Server)

Affinity Mapping Studio の共同編集サーバー実装．Yjs リアルタイム同期 + 招待リスト + 監査ログを提供．

> 2026-06-15 リネーム: **KJ Studio Server** → **Affinity Mapping Studio Server (AMS Server)**．
> ディレクトリ名は後方互換性のため `kj-trace-server/` のまま保持．npm package 名は
> `affinity-mapping-studio-server`．プロトコル契約 (`kj-studio.v1` subprotocol /
> `kj-room-` キー / `KJ_*` env / `.kjproj` / `getMap('tables')`) は互換維持のため不変．

## できること (Phase 4b-1)

- WebSocket で複数クライアントを受け付け，Yjs プロトコルで同期
- **ルームメタデータ管理**: `auditLogging` (off/on) と `accessControl` (open/invite_list) をプロジェクトごとに設定
- **招待リスト**: `invite_list` モードでは登録済みメアドのみ接続可
- **監査ログ**: `auditLogging=on` のとき全 Yjs transaction を user / nick / ip / bytes / timestamp 付きで永続記録
- **CSV エクスポート**: IRB 提出用ログを `kj-admin audit <room> --csv out.csv` で抽出
- Awareness API でプレゼンス（誰がオンライン）共有
- Y.Doc updates をファイル append-log で永続化

## セットアップ

```bash
cd kj-trace-server
npm install
npm start
```

既定ポート: `1234`．`PORT=9999 npm start` で変更可．

## 管理 CLI (kj-admin)

```bash
npm run admin -- help              # ヘルプ
npm run admin -- room list         # ルーム一覧
npm run admin -- room create kjlab2026 --name "KJ Lab 2026" --audit on --access invite_list
npm run admin -- invite kjlab2026 alice@example.ac.jp --role editor
npm run admin -- revoke kjlab2026 alice@example.ac.jp
npm run admin -- room set kjlab2026 --audit off
npm run admin -- audit kjlab2026                       # 末尾 20 件を表示
npm run admin -- audit kjlab2026 --since 2026-05-01    # 日付フィルタ
npm run admin -- audit kjlab2026 --csv ./audit.csv     # CSV エクスポート
npm run admin -- room delete kjlab2026
```

## プロファイル

`auditLogging × accessControl` の組み合わせで 4 プロファイル：

| プロファイル | 監査 | アクセス | 用途 |
|---|---|---|---|
| **A. 練習用** (既定) | OFF | OPEN | ゼミでのお試し / 個人作業 |
| **B. 共同分析** | OFF | INVITE | メンバー限定だがログ不要 |
| **C. 監査用** | ON | OPEN | 個人研究で作業ログを残したい |
| **D. 厳格** | ON | INVITE | IRB 対象本研究 |

ルームを `kj-admin room create` で作らずに WebSocket クライアントが接続した場合は **プロファイル A** で自動作成される．

## クライアント接続

WebSocket URL:
```
ws://<host>:1234/<roomId>?email=alice@xxx&nick=Alice
```

クエリパラメータ:
- `email`: ログイン用メアド．OPEN モードでは空欄可．INVITE_LIST モードでは必須
- `nick`: 画面表示用ニックネーム（任意）

INVITE_LIST モードで登録外メアド or 空欄の場合 → HTTP 401 で upgrade 拒否

## ヘッドレステスト

```bash
node test-smoke.js
```

14 項目チェック (OPEN sync / INVITE 拒否 / INVITE 許可 / 監査ログ / CSV / 永続化) が **OK** で終了するか確認．

## ファイル構成

```
kj-trace-server/
├─ package.json
├─ src/
│  ├─ index.js           ; WebSocket サーバー + verifyClient 認証
│  ├─ rooms.js           ; ルームメタ + 招待リスト (JSON)
│  ├─ audit.js           ; 監査ログ append-only + CSV
│  └─ persistence.js     ; Y.Doc updates の永続化
├─ bin/
│  └─ kj-admin.js        ; 管理 CLI
├─ data/
│  ├─ rooms.json         ; ルーム + 招待リスト
│  ├─ audit/<id>.jsonl   ; 監査ログ
│  └─ <id>.bin           ; Y.Doc updates
├─ test-client.html      ; ブラウザ最小クライアント
├─ test-smoke.js         ; ヘッドレステスト
└─ README.md
```

## 制限 (Phase 4b-1 として割り切り)

- **22 テーブル全部の Y.Doc マッピングはまだ**: 現状は任意の `Y.Array` / `Y.Map` を受け付けるだけ．Phase 4b-2 で KJ Trace Studio の全 schema をマップ
- **TLS / WSS なし**: VPN 経由前提．Phase 4b-3 で reverse-proxy 構成サンプル提供予定
- **JSON ファイル DB**: ゼミ規模で十分．数千ユーザーになれば SQLite 化
- **コンパクション未実装**: `data/<room>.bin` は append-only．長期運用で肥大する

## 関連

- 設計書: `../docs/yjs-sync-design.md`
- Phase 4 全体ロードマップ: 同設計書 §9
