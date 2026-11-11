// prepare-bundle.mjs -- インストーラに入れる同梱物を gui/resources/ に揃える．
//
//   resources/server/        サーバ (src・bin・package.json など．git に入っている版) と node_modules
//   resources/node-runtime/  Node.js 本体 (Windows: node.exe / macOS: bin/node)
//   resources/cloudflared/   cloudflared
//
// 使い方 (gui/ で):  node scripts/prepare-bundle.mjs [--arch x64|arm64]
//   OS は実行している OS に合わせる．--arch を省くと実行している PC の arch．
//   Windows と macOS の両方で動く (GitHub Actions でも同じものを使う)．
//
// 安全のための決まり:
//   - サーバは git archive HEAD から取り出す．作業中の変更や，git に入れていない内部の記録・秘密
//     (config/admin-token.txt・data/ など) が入らないようにするため．
//   - Node.js と cloudflared は版を固定し，SHA256 を照合する．合わなければ止める．

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync, chmodSync, copyFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const NODE_VERSION = '24.14.1';
const NODE_SHA256 = {
  'win32-x64': '6e50ce5498c0cebc20fd39ab3ff5df836ed2f8a31aa093cecad8497cff126d70', // node-v24.14.1-win-x64.zip
  'darwin-arm64': '25495ff85bd89e2d8a24d88566d7e2f827c6b0d3d872b2cebf75371f93fcb1fe', // node-v24.14.1-darwin-arm64.tar.gz
  'darwin-x64': '2526230ad7d922be82d4fdb1e7ee1e84303e133e3b4b0ec4c2897ab31de0253d', // node-v24.14.1-darwin-x64.tar.gz
};

const CLOUDFLARED_VERSION = '2026.10.3';
// GitHub の配布物の digest (gh release view 2026.10.3 -R cloudflare/cloudflared --json assets)
const CLOUDFLARED = {
  'win32-x64': { file: 'cloudflared-windows-amd64.exe', sha256: '76b2805253d0d6ffacb092a7acfbee99e7af6917835c0c5410e23f3ef5052da2' },
  'darwin-arm64': { file: 'cloudflared-darwin-arm64.tgz', sha256: '1165d14b6f6360a3b8c283d7d1100024d6ec7cd9bc9e32519e96150645f3ec55' },
  'darwin-x64': { file: 'cloudflared-darwin-amd64.tgz', sha256: '81b7b85f2376815c4f59b1aa323887b62e16ce8b67555c2e1577dc23f2a82000' },
};

// サーバのうち，動かすのに要るものだけを入れる (テスト・開発用の道具・ドキュメントの画像は入れない)．
const SERVER_PATHS = ['src', 'bin', 'package.json', 'package-lock.json', 'LICENSE', 'NOTICE', 'README.md'];

const __dirname = dirname(fileURLToPath(import.meta.url));
const GUI = resolve(__dirname, '..');
const REPO = resolve(GUI, '..');
const RES = join(GUI, 'resources');

function die(msg) {
  console.error(`\n[prepare-bundle] ERROR: ${msg}`);
  process.exit(1);
}

const argArch = (() => {
  const i = process.argv.indexOf('--arch');
  return i >= 0 ? process.argv[i + 1] : process.arch;
})();
const key = `${process.platform}-${argArch}`;
if (!NODE_SHA256[key]) die(`この組み合わせには対応していません: ${key} (対応: ${Object.keys(NODE_SHA256).join(', ')})`);

// Windows では OS の tar (bsdtar) を使う．Git の GNU tar は C: をリモートのホスト名と解釈して失敗する．
const TAR = process.platform === 'win32' ? join(process.env.SystemRoot || 'C:/Windows', 'System32', 'tar.exe') : 'tar';

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

async function download(url, dest, expected) {
  console.log(`[download] ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) die(`ダウンロードに失敗しました (HTTP ${res.status}): ${url}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  const got = sha256(dest);
  if (got !== expected) die(`SHA256 が合いません: ${url}\n  期待: ${expected}\n  実際: ${got}`);
  console.log(`[sha256] OK ${got}`);
}

function fresh(dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

const work = join(tmpdir(), `ams-prepare-${process.pid}`);
fresh(work);

// 1. サーバ
{
  const dest = join(RES, 'server');
  fresh(dest);
  const dirty = execFileSync('git', ['status', '--porcelain', '--', ...SERVER_PATHS], { cwd: REPO }).toString().trim();
  if (dirty) console.warn(`[server] 注意: コミットしていない変更は入りません (git archive HEAD を使います):\n${dirty}`);
  const tar = join(work, 'server.tar');
  run('git', ['archive', '--format=tar', '-o', tar, 'HEAD', '--', ...SERVER_PATHS], { cwd: REPO });
  run(TAR, ['-xf', tar, '-C', dest]);
  rmSync(join(dest, 'src', '__tests__'), { recursive: true, force: true });
  // 依存は JavaScript だけ (yjs・ws・lib0・y-protocols) なので，ビルドする PC の npm で入れてよい．
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  run(npm, ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: dest, shell: process.platform === 'win32' });
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO }).toString().trim();
  writeFileSync(join(dest, 'BUNDLE_INFO.json'), JSON.stringify({ commit, node: NODE_VERSION, cloudflared: CLOUDFLARED_VERSION, platform: key }, null, 2) + '\n');
  console.log(`[server] OK (commit ${commit.slice(0, 7)})`);
}

// 2. Node.js
{
  const dest = join(RES, 'node-runtime');
  fresh(dest);
  if (process.platform === 'win32') {
    const name = `node-v${NODE_VERSION}-win-x64`;
    const zip = join(work, `${name}.zip`);
    await download(`https://nodejs.org/dist/v${NODE_VERSION}/${name}.zip`, zip, NODE_SHA256[key]);
    run(TAR, ['-xf', zip, '-C', work]);
    copyFileSync(join(work, name, 'node.exe'), join(dest, 'node.exe'));
    copyFileSync(join(work, name, 'LICENSE'), join(dest, 'LICENSE'));
  } else {
    const name = `node-v${NODE_VERSION}-darwin-${argArch}`;
    const tgz = join(work, `${name}.tar.gz`);
    await download(`https://nodejs.org/dist/v${NODE_VERSION}/${name}.tar.gz`, tgz, NODE_SHA256[key]);
    run(TAR, ['-xzf', tgz, '-C', work]);
    mkdirSync(join(dest, 'bin'), { recursive: true });
    copyFileSync(join(work, name, 'bin', 'node'), join(dest, 'bin', 'node'));
    chmodSync(join(dest, 'bin', 'node'), 0o755);
    copyFileSync(join(work, name, 'LICENSE'), join(dest, 'LICENSE'));
  }
  console.log('[node-runtime] OK');
}

// 3. cloudflared
{
  const dest = join(RES, 'cloudflared');
  fresh(dest);
  const { file, sha256: expected } = CLOUDFLARED[key];
  const url = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${file}`;
  const dl = join(work, file);
  await download(url, dl, expected);
  if (process.platform === 'win32') {
    copyFileSync(dl, join(dest, 'cloudflared.exe'));
  } else {
    const x = join(work, 'cf');
    fresh(x);
    run(TAR, ['-xzf', dl, '-C', x]);
    const bin = readdirSync(x).find((n) => n === 'cloudflared');
    if (!bin) die('cloudflared の tgz の中に cloudflared がありません');
    copyFileSync(join(x, bin), join(dest, 'cloudflared'));
    chmodSync(join(dest, 'cloudflared'), 0o755);
  }
  writeFileSync(join(dest, 'README.txt'),
    `cloudflared ${CLOUDFLARED_VERSION} (Cloudflare, Inc.)\n` +
    'Apache License 2.0: https://github.com/cloudflare/cloudflared/blob/master/LICENSE\n' +
    `Source: https://github.com/cloudflare/cloudflared/releases/tag/${CLOUDFLARED_VERSION}\n`);
  console.log('[cloudflared] OK');
}

rmSync(work, { recursive: true, force: true });
for (const d of ['server', 'node-runtime', 'cloudflared']) {
  if (!existsSync(join(RES, d))) die(`resources/${d} がありません`);
}
console.log(`\n[prepare-bundle] 完了: ${key}`);
