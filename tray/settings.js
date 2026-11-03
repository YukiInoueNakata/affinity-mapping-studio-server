// Settings window renderer.  Uses the `window.tray` IPC bridge from preload.cjs.
//
// The status pill auto-refreshes every 3 seconds so the UI reflects the
// running state.  The input fields are written only at initial load + after
// an explicit save — otherwise we'd overwrite whatever the user is typing.

async function refreshStatus() {
  const s = await window.tray.getState();
  const status = document.getElementById('status');
  status.className = 'status ' + (s.running ? 'on' : 'off');
  status.textContent = s.running
    ? 'サーバー起動中 (port ' + s.port + ')'
    : 'サーバー停止中';
}

async function loadInputs() {
  const s = await window.tray.getState();
  document.getElementById('token').value = s.token ?? '';
  document.getElementById('port').value = s.port ?? 1234;
  await refreshStatus();
}

document.getElementById('saveBtn').addEventListener('click', async () => {
  const token = document.getElementById('token').value.trim();
  const port = Number(document.getElementById('port').value) || 1234;
  await window.tray.saveSettings({ token, port });
  document.getElementById('saved').textContent = '保存しました';
  setTimeout(() => (document.getElementById('saved').textContent = ''), 1800);
  await refreshStatus();
});

document.getElementById('startBtn').addEventListener('click', async () => {
  await window.tray.startServer();
  setTimeout(refreshStatus, 600);
});

document.getElementById('stopBtn').addEventListener('click', async () => {
  await window.tray.stopServer();
  setTimeout(refreshStatus, 400);
});

loadInputs();
// Only the status pill auto-refreshes; the inputs stay untouched so the user
// can edit without their text being overwritten.
setInterval(refreshStatus, 3000);
