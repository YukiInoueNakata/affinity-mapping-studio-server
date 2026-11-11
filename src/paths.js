// paths.js -- データと設定の置き場所を 1 か所で決める．
//
// 既定はソースの隣の data/ と config/（これまでどおり）．
// 管理 GUI のインストーラ版は，アプリのフォルダの外（利用者のアプリデータ）に置くため，
// 環境変数で上書きする．インストール先に置くと，更新やアンインストールでデータが消え，
// macOS ではアプリの中に書き込めないため（2026-11-11）．
//
//   KJ_DATA_DIR   : 部屋のデータ・監査ログ・スナップショット・runtime.json
//   KJ_CONFIG_DIR : server.json・admin-token.txt

import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const SERVER_ROOT = join(__dirname, '..');

function fromEnv(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') return fallback;
  return resolve(v.trim());
}

export const DATA_DIR = fromEnv('KJ_DATA_DIR', join(SERVER_ROOT, 'data'));
export const CONFIG_DIR = fromEnv('KJ_CONFIG_DIR', join(SERVER_ROOT, 'config'));
