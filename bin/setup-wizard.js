#!/usr/bin/env node
// kj-server setup-wizard — 対話的に公開方式 (exposure) を選んで config/server.json を生成．
//
// 使い方:
//   node bin/setup-wizard.js
//
// 既存 config がある場合は確認の上上書き．admin-token も同時に生成可．

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { EXPOSURE_PRESETS } from '../src/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = join(__dirname, '..', 'config');
const CONFIG_PATH = join(CONFIG_DIR, 'server.json');
const TOKEN_PATH = join(CONFIG_DIR, 'admin-token.txt');

const rl = createInterface({ input: stdin, output: stdout });

async function ask(prompt, opts = {}) {
  const def = opts.default != null ? ` [${opts.default}]` : '';
  const a = (await rl.question(`${prompt}${def}: `)).trim();
  return a.length === 0 ? (opts.default ?? '') : a;
}

async function askYN(prompt, defaultYes = true) {
  const def = defaultYes ? 'Y/n' : 'y/N';
  const a = (await rl.question(`${prompt} [${def}]: `)).trim().toLowerCase();
  if (a.length === 0) return defaultYes;
  return a === 'y' || a === 'yes';
}

function generateAdminToken() {
  return randomBytes(32).toString('hex');
}

async function main() {
  console.log('============================================================');
  console.log('  Affinity Mapping Studio Server 起動ウィザード');
  console.log('============================================================');
  console.log();
  console.log('このウィザードは config/server.json と config/admin-token.txt を');
  console.log('対話形式で生成します．既存ファイルがあれば上書き確認します．');
  console.log();

  // 既存 config 確認
  let existingConfig = null;
  try {
    const raw = await readFile(CONFIG_PATH, 'utf-8');
    existingConfig = JSON.parse(raw);
    console.log(`既存設定が見つかりました: ${CONFIG_PATH}`);
    console.log(`  現在のプリセット: ${existingConfig.exposure?.preset ?? '(未設定)'}`);
    const overwrite = await askYN('上書きしますか?', false);
    if (!overwrite) {
      console.log('中断しました．');
      rl.close();
      return;
    }
    console.log();
  } catch {
    // 既存なし
  }

  // プリセット選択
  console.log('1. 公開方式 (exposure) を選んでください:');
  console.log();
  const entries = Object.entries(EXPOSURE_PRESETS);
  entries.forEach(([name, p], i) => {
    console.log(`  [${i + 1}] ${p.label} (${name})`);
    console.log(`      ${p.description}`);
  });
  console.log();
  let chosen = null;
  while (!chosen) {
    const a = await ask('番号を入力', { default: '1' });
    const n = Number(a);
    if (n >= 1 && n <= entries.length) {
      chosen = entries[n - 1];
    } else {
      console.log('  範囲外です．もう一度入力してください．');
    }
  }
  const [presetName, preset] = chosen;
  console.log(`→ 選択: ${preset.label} (${presetName})`);
  console.log();

  // network 設定
  console.log('2. ネットワーク設定 (空欄で既定値):');
  const appBindHost = await ask(
    '  共同作業 endpoint の bind host',
    { default: preset.suggestedBindHost ?? '0.0.0.0' }
  );
  const appPort = await ask('  共同作業 endpoint の port', { default: '1234' });
  const adminBindHost = await ask(
    '  管理画面の bind host (localhost-only を強く推奨)',
    { default: '127.0.0.1' }
  );
  const adminPort = await ask('  管理画面の port', { default: '1235' });
  console.log();

  // 認証設定
  console.log('3. 認証方式 (Sec-111):');
  const allowLegacyEmail = await askYN(
    '  legacy email 自己申告を許可? (旧 v0.2.x クライアント互換．非推奨)',
    !preset.requireAuth
  );
  const allowedCidrs = await ask(
    '  ip-cidr allowlist (カンマ区切り．例: 192.168.1.0/24,10.0.0.0/8)',
    { default: '' }
  );
  let trustedProxyHeader = '';
  if (presetName === 'reverse-proxy') {
    trustedProxyHeader = await ask(
      '  trusted-proxy header 名 (例: X-Authenticated-User．空でスキップ)',
      { default: '' }
    );
  }
  console.log();

  // admin token
  console.log('4. 管理トークン:');
  let adminToken = '';
  try {
    adminToken = (await readFile(TOKEN_PATH, 'utf-8')).trim();
    console.log(`  既存 token: ${adminToken.slice(0, 8)}...${adminToken.slice(-4)} (config/admin-token.txt)`);
    const regen = await askYN('  再発行しますか?', false);
    if (regen) adminToken = generateAdminToken();
  } catch {
    adminToken = generateAdminToken();
    console.log('  新規 token を生成しました');
  }
  console.log();

  // 書き込み確認
  console.log('============================================================');
  console.log('以下の内容で保存します:');
  console.log('============================================================');
  console.log(`  preset: ${presetName} (${preset.label})`);
  console.log(`  app: http://${appBindHost}:${appPort}`);
  console.log(`  admin: http://${adminBindHost}:${adminPort}/admin`);
  console.log(`  legacy email: ${allowLegacyEmail ? 'allow' : 'reject'}`);
  console.log(`  allowed CIDRs: ${allowedCidrs || '(none)'}`);
  console.log(`  trusted-proxy header: ${trustedProxyHeader || '(none)'}`);
  console.log(`  admin token: ${adminToken.slice(0, 8)}...${adminToken.slice(-4)}`);
  console.log();
  const ok = await askYN('保存しますか?', true);
  if (!ok) {
    console.log('中断しました．');
    rl.close();
    return;
  }

  // 書き込み
  try { await stat(CONFIG_DIR); } catch { await mkdir(CONFIG_DIR, { recursive: true }); }
  const newConfig = {
    $schema: 'kj-studio-server-config-v1',
    exposure: { preset: presetName },
    network: {
      appBindHost,
      appPort: Number(appPort),
      adminBindHost,
      adminPort: Number(adminPort),
    },
    auth: {
      legacyEmail: allowLegacyEmail,
      allowedCidrs: allowedCidrs ? allowedCidrs.split(',').map((s) => s.trim()).filter(Boolean) : [],
      trustedProxyHeader,
    },
    appliedAt: new Date().toISOString(),
  };
  await writeFile(CONFIG_PATH, JSON.stringify(newConfig, null, 2), 'utf-8');
  await writeFile(TOKEN_PATH, adminToken, 'utf-8');

  console.log();
  console.log('============================================================');
  console.log('  完了');
  console.log('============================================================');
  console.log(`  config: ${CONFIG_PATH}`);
  console.log(`  token : ${TOKEN_PATH}`);
  console.log();
  console.log('次の手順:');
  console.log('  1. サーバー起動: npm start （または start-server.bat）');
  console.log('  2. 管理画面: http://' + adminBindHost + ':' + adminPort + '/admin');
  console.log('  3. ブラウザで管理 token を入力してログイン');
  console.log();

  // preset 別の追加手順
  if (presetName === 'cloudflare-quick') {
    console.log('  ▼ Cloudflare Quick Tunnel 起動方法:');
    console.log('     cloudflared tunnel --url http://localhost:' + appPort);
  } else if (presetName === 'cloudflare-named') {
    console.log('  ▼ Cloudflare Named Tunnel:');
    console.log('     cloudflared tunnel run --token <your-tunnel-token>');
    console.log('     ※ DNS と ingress rule の事前設定が必要');
  } else if (presetName === 'tailscale-serve') {
    console.log('  ▼ Tailscale Serve:');
    console.log('     tailscale serve --bg http://localhost:' + appPort);
  } else if (presetName === 'tailscale-funnel') {
    console.log('  ▼ Tailscale Funnel:');
    console.log('     tailscale funnel --bg http://localhost:' + appPort);
  }
  rl.close();
}

main().catch((e) => {
  console.error('Setup wizard failed:', e);
  rl.close();
  process.exit(1);
});
