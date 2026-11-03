// Tray-based launcher for Affinity Mapping Studio Server (旧名: kj-trace-server).
//
// Spawns the server as a child Node process and exposes start/stop +
// "open admin" + "settings" via the system tray icon.
//
// Run with:
//   npm run tray
//
// Settings (KJ_ADMIN_TOKEN, port) are stored in the Electron userData dir
// so they persist across launches without needing to set environment vars.

const { app, Tray, Menu, BrowserWindow, dialog, nativeImage, shell, ipcMain } =
  require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const SERVER_ROOT = path.resolve(__dirname, '..');
const SERVER_ENTRY = path.join(SERVER_ROOT, 'src', 'index.js');
const ICON_PATH = path.join(__dirname, 'icon.png');

let tray = null;
let serverProcess = null;
let settings = { token: '', port: 1234 };

function configPath() {
  return path.join(app.getPath('userData'), 'tray-settings.json');
}

function loadSettings() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    if (typeof parsed.token === 'string') settings.token = parsed.token;
    if (typeof parsed.port === 'number') settings.port = parsed.port;
  } catch {
    /* first run — no file yet */
  }
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(settings, null, 2), 'utf-8');
  } catch (e) {
    console.error('[tray] failed to save settings:', e);
  }
}

function isRunning() {
  return serverProcess !== null && !serverProcess.killed;
}

function startServer() {
  if (isRunning()) return;
  if (!settings.token) {
    dialog.showMessageBoxSync({
      type: 'warning',
      buttons: ['OK'],
      message: 'まず KJ_ADMIN_TOKEN を設定してください',
      detail: '「設定...」メニューから管理用トークンを入力してください．',
    });
    return;
  }
  serverProcess = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: SERVER_ROOT,
    env: {
      ...process.env,
      KJ_ADMIN_TOKEN: settings.token,
      PORT: String(settings.port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProcess.stdout.on('data', (d) => {
    process.stdout.write('[server] ' + d.toString());
  });
  serverProcess.stderr.on('data', (d) => {
    process.stderr.write('[server-err] ' + d.toString());
  });
  serverProcess.on('exit', (code, signal) => {
    console.log(`[tray] server exited code=${code} signal=${signal}`);
    serverProcess = null;
    updateTrayMenu();
  });
  serverProcess.on('error', (err) => {
    console.error('[tray] failed to start server:', err);
    serverProcess = null;
    updateTrayMenu();
    dialog.showErrorBox('サーバー起動失敗', String(err.message ?? err));
  });
  updateTrayMenu();
}

function stopServer() {
  if (!serverProcess) return;
  try {
    serverProcess.kill();
  } catch (e) {
    console.error('[tray] kill failed:', e);
  }
  serverProcess = null;
  updateTrayMenu();
}

function openAdmin() {
  shell.openExternal(`http://localhost:${settings.port}/admin`);
}

function updateTrayMenu() {
  if (!tray) return;
  const running = isRunning();
  tray.setToolTip(
    running
      ? `Affinity Mapping Studio Server (running on :${settings.port})`
      : 'Affinity Mapping Studio Server (stopped)'
  );
  const menu = Menu.buildFromTemplate([
    {
      label: running
        ? `状態: 起動中 (port ${settings.port})`
        : '状態: 停止',
      enabled: false,
    },
    { type: 'separator' },
    {
      label: running ? 'サーバー停止' : 'サーバー起動',
      click: () => (running ? stopServer() : startServer()),
    },
    {
      label: '管理画面を開く',
      enabled: running,
      click: openAdmin,
    },
    { type: 'separator' },
    {
      label: '設定...',
      click: () => openSettingsWindow(),
    },
    { type: 'separator' },
    {
      label: '終了',
      click: () => {
        stopServer();
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
}

let settingsWindow = null;
function openSettingsWindow() {
  if (settingsWindow) {
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 460,
    height: 360,
    title: 'Affinity Mapping Studio Server 設定',
    resizable: false,
    minimizable: false,
    maximizable: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  settingsWindow.setMenu(null);
  settingsWindow.loadFile(path.join(__dirname, 'settings.html'));
  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
}

// IPC for the settings window
ipcMain.handle('tray:get-state', () => ({
  token: settings.token,
  port: settings.port,
  running: isRunning(),
}));
ipcMain.handle('tray:save-settings', (_e, opts) => {
  if (typeof opts.token === 'string') settings.token = opts.token.trim();
  if (typeof opts.port === 'number' && opts.port > 0 && opts.port < 65536) {
    settings.port = opts.port;
  }
  saveSettings();
  updateTrayMenu();
  return { token: settings.token, port: settings.port };
});
ipcMain.handle('tray:start', () => {
  startServer();
});
ipcMain.handle('tray:stop', () => {
  stopServer();
});

// Single-instance lock so launching the tray app twice just focuses
// the existing one.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    openSettingsWindow();
  });
}

app.whenReady().then(() => {
  loadSettings();
  let icon = nativeImage.createFromPath(ICON_PATH);
  if (icon.isEmpty()) {
    // Fallback: 16x16 solid color via data URL — replace icon.png later.
    icon = nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAS0lEQVR4nGNgGAWjYBSMglEwCkbBKBgFo2AUjIJRMAr+AwMACiwAAVeJq6oAAAAASUVORK5CYII='
    );
  }
  tray = new Tray(icon);
  updateTrayMenu();
  // macOS: hide the dock icon since we're a tray-only app
  if (process.platform === 'darwin' && app.dock) app.dock.hide();
});

app.on('before-quit', () => {
  stopServer();
});
app.on('window-all-closed', (e) => {
  // Don't quit — keep the tray running until user picks "終了".
  e.preventDefault();
});
