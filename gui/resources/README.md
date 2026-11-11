# 同梱物 (git に入れない)

インストーラに入れるものを置く場所です．中身は `scripts/prepare-bundle.mjs` が作ります．

| フォルダ | 中身 |
|---|---|
| `server/` | サーバ (git archive HEAD の src・bin・package.json など) と node_modules |
| `node-runtime/` | Node.js 本体 (版と SHA256 は prepare-bundle.mjs に固定) |
| `cloudflared/` | cloudflared (版と SHA256 は prepare-bundle.mjs に固定) |

```bash
cd gui
node scripts/prepare-bundle.mjs            # 実行している PC の OS・arch 用
node scripts/prepare-bundle.mjs --arch x64 # macOS で Intel 用を作るとき
```
