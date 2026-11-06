    // -------- auth --------
    const TOKEN_KEY = 'kj-admin-token';

    // R6 (2026-06-09): URL から token 自動注入．
    // 主: fragment #_t=<token> (server に送られない)
    // 互換: query ?_t=<token> + console.warn (deprecation)
    (function autoInjectAdminToken() {
      const hashMatch = (location.hash || '').match(/[#&]_t=([^&]+)/);
      if (hashMatch) {
        try {
          sessionStorage.setItem(TOKEN_KEY, decodeURIComponent(hashMatch[1]));
        } catch (e) {
          console.warn('[admin] fragment _t= decode failed:', e);
        }
        // fragment を URL から消す (履歴 / 画面共有時の漏洩防止)
        history.replaceState(null, '', location.pathname + location.search);
        return;
      }
      const url = new URL(location.href);
      const queryToken = url.searchParams.get('_t');
      if (queryToken) {
        sessionStorage.setItem(TOKEN_KEY, queryToken);
        url.searchParams.delete('_t');
        history.replaceState(null, '', url.pathname + url.search + url.hash);
        console.warn('[admin] _t= via query is deprecated; use #_t= (fragment) instead');
      }
    })();

    function getToken() {
      let t = sessionStorage.getItem(TOKEN_KEY);
      if (!t) {
        t = prompt('管理トークンを入力してください．\nサーバーのフォルダの config/admin-token.txt の中身（64 文字）をそのまま貼り付けます．');
        if (!t) { document.body.textContent = 'token required'; throw new Error('no token'); }
        sessionStorage.setItem(TOKEN_KEY, t);
      }
      return t;
    }
    function logout() {
      sessionStorage.removeItem(TOKEN_KEY);
      location.reload();
    }
    document.getElementById('logoutBtn').onclick = logout;

    function showError(msg) {
      const el = document.getElementById('errorBar');
      el.textContent = msg;
      el.style.display = 'block';
      setTimeout(() => (el.style.display = 'none'), 5000);
    }

    async function api(path, opts = {}) {
      const res = await fetch('/admin/api' + path, {
        ...opts,
        headers: {
          'Authorization': 'Bearer ' + getToken(),
          'Content-Type': 'application/json',
          ...(opts.headers ?? {}),
        },
      });
      if (res.status === 401) {
        sessionStorage.removeItem(TOKEN_KEY);
        showError('認証エラー: トークンが違います．再読み込みします．');
        setTimeout(() => location.reload(), 1500);
        throw new Error('unauthorized');
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(body.error ?? res.statusText);
      }
      const ct = res.headers.get('content-type') ?? '';
      return ct.includes('json') ? res.json() : res.text();
    }

    // -------- state --------
    let rooms = [];
    let selectedId = null;

    async function loadRooms() {
      try {
        rooms = await api('/rooms');
        renderRoomList();
        if (selectedId && !rooms.find((r) => r.id === selectedId)) {
          selectedId = null;
        }
        renderDetail();
      } catch (e) {
        showError('ルーム取得失敗: ' + e.message);
      }
    }

    function renderRoomList() {
      const el = document.getElementById('roomList');
      if (!rooms.length) {
        el.innerHTML = '<div class="empty">ルーム無し</div>';
        return;
      }
      el.innerHTML = '';
      rooms.forEach((r) => {
        const item = document.createElement('div');
        item.className = 'room-item' + (r.id === selectedId ? ' selected' : '');
        const sizePill = typeof r.fileBytes === 'number'
          ? ' · <span class="pill ' + (r.fileBytes >= 64 * 1024 * 1024 ? 'size-warn' : 'size') + '">' + formatBytes(r.fileBytes) + '</span>'
          : '';
        item.innerHTML =
          '<div class="name">' + escapeHtml(r.name ?? r.id) + '</div>' +
          '<div class="sub">' + r.id + ' · ' + (r.accessControl ?? 'open') +
          (r.auditLogging === 'on' ? ' · <span class="pill audit">監査</span>' : '') +
          sizePill +
          '</div>';
        item.onclick = () => { selectedId = r.id; renderRoomList(); renderDetail(); };
        el.appendChild(item);
      });
    }

    async function renderDetail() {
      const main = document.getElementById('detail');
      if (!selectedId) {
        main.innerHTML = '<div class="empty">左のリストからルームを選択してください．</div>';
        return;
      }
      const r = rooms.find((x) => x.id === selectedId);
      if (!r) return;

      main.innerHTML = '';

      // 基本情報
      const basic = document.createElement('section');
      basic.innerHTML = '<h3>ルーム設定</h3>';
      basic.appendChild(formRow('ID', r.id, true));
      basic.appendChild(textInput('名前', r.name ?? '', (v) => updateRoom({ name: v })));
      basic.appendChild(selectInput('接続', r.accessControl ?? 'open', ['open', 'invite_list'], (v) => updateRoom({ access: v })));
      basic.appendChild(selectInput('監査', r.auditLogging ?? 'off', ['off', 'on'], (v) => updateRoom({ audit: v })));
      const del = document.createElement('button');
      del.className = 'danger';
      del.textContent = 'このルームを削除';
      del.style.marginTop = '8px';
      del.onclick = () => deleteRoom(r.id);
      basic.appendChild(del);
      main.appendChild(basic);

      // 招待
      const inv = document.createElement('section');
      inv.innerHTML = '<h3>招待 (' + (r.invitations?.length ?? 0) + ' 件)</h3>';
      const invForm = document.createElement('div');
      invForm.className = 'row';
      invForm.style.alignItems = 'flex-start';
      // 2026-06-02: 複数メアドを一度に招待できるよう textarea に変更．
      // カンマ / 改行 / 空白で区切り可．
      const emailInput = document.createElement('textarea');
      emailInput.placeholder = 'メアド (カンマ・改行・空白区切りで複数可)\n例: a@x.jp, b@x.jp\n   c@x.jp';
      emailInput.style.width = '300px';
      emailInput.style.height = '60px';
      emailInput.style.fontFamily = 'monospace';
      emailInput.style.fontSize = '12px';
      const roleSel = document.createElement('select');
      ['editor', 'viewer', 'admin'].forEach((x) => {
        const o = document.createElement('option'); o.value = x; o.textContent = x;
        roleSel.appendChild(o);
      });
      // 2026-06-03 Sec-111: 有効期限 / 最大使用回数の入力欄
      const expiryInput = document.createElement('input');
      expiryInput.type = 'datetime-local';
      expiryInput.title = '有効期限（任意．空なら無期限）';
      expiryInput.style.fontSize = '11px';
      const maxUsesInput = document.createElement('input');
      maxUsesInput.type = 'number';
      maxUsesInput.placeholder = '最大使用回数';
      maxUsesInput.title = '最大使用回数（任意．空なら無制限．1 で one-time use）';
      maxUsesInput.style.width = '90px';
      maxUsesInput.style.fontSize = '11px';
      maxUsesInput.min = '1';
      const inviteBtn = document.createElement('button');
      inviteBtn.className = 'primary';
      inviteBtn.textContent = '招待';
      inviteBtn.onclick = async () => {
        const raw = emailInput.value.trim();
        if (!raw) return;
        try {
          const list = raw.split(/[,\n;\s]+/).map((s) => s.trim()).filter(Boolean);
          const body = { emails: list, role: roleSel.value };
          if (expiryInput.value) {
            // datetime-local は local time → ISO に変換
            body.expiresAt = new Date(expiryInput.value).toISOString();
          }
          if (maxUsesInput.value) {
            body.maxUses = Number(maxUsesInput.value);
          }
          const result = await api('/rooms/' + encodeURIComponent(r.id) + '/invitations', {
            method: 'POST',
            body: JSON.stringify(body),
          });
          const ok = (result.invited ?? []).filter((x) => x.ok).length;
          const fail = (result.invited ?? []).filter((x) => !x.ok);
          if (fail.length > 0) {
            showError('一部失敗 (' + ok + ' OK / ' + fail.length + ' NG): ' + fail.map((x) => x.email + ': ' + x.error).join(' / '));
          }
          emailInput.value = '';
          expiryInput.value = '';
          maxUsesInput.value = '';
          await loadRooms();
        } catch (e) { showError('招待失敗: ' + e.message); }
      };
      invForm.appendChild(emailInput);
      const sideCol = document.createElement('div');
      sideCol.style.display = 'flex';
      sideCol.style.flexDirection = 'column';
      sideCol.style.gap = '4px';
      sideCol.appendChild(roleSel);
      sideCol.appendChild(expiryInput);
      sideCol.appendChild(maxUsesInput);
      sideCol.appendChild(inviteBtn);
      invForm.appendChild(sideCol);
      inv.appendChild(invForm);

      // 2026-06-03 Sec-111: ルームパスワード設定欄
      const pwForm = document.createElement('div');
      pwForm.className = 'row';
      pwForm.style.marginTop = '4px';
      pwForm.style.alignItems = 'center';
      pwForm.style.gap = '6px';
      // B3 (2026-06-09): password reveal — 設定直後の sessionStorage キャッシュ経由のみ
      const pwLabel = document.createElement('span');
      pwLabel.textContent = 'ルーム共通パスワード:';
      pwLabel.style.fontSize = '12px';
      const pwStatus = document.createElement('span');
      pwStatus.style.fontSize = '11px';
      pwStatus.textContent = r.passwordHash ? '設定済み' : '未設定';
      pwStatus.style.color = r.passwordHash ? '#2a8' : 'var(--muted)';
      // B3: session キャッシュ確認．設定直後なら reveal 可
      const PW_CACHE_KEY = 'kj-pw-cache:' + r.id;
      const cached = sessionStorage.getItem(PW_CACHE_KEY);
      if (r.passwordHash && cached) {
        const revealBtn = document.createElement('button');
        revealBtn.textContent = '👁 表示';
        revealBtn.title = 'session 内キャッシュ．再ロードで消えます';
        revealBtn.style.fontSize = '11px';
        let shown = false;
        revealBtn.onclick = () => {
          shown = !shown;
          revealBtn.textContent = shown ? '🙈 隠す' : '👁 表示';
          pwRevealValue.textContent = shown ? cached : '●●●●●●';
          pwRevealValue.style.display = '';
        };
        const pwRevealValue = document.createElement('code');
        pwRevealValue.textContent = '●●●●●●';
        pwRevealValue.style.fontSize = '11px';
        pwRevealValue.style.color = '#666';
        pwRevealValue.style.marginLeft = '4px';
        const copyPwBtn = document.createElement('button');
        copyPwBtn.textContent = '📋';
        copyPwBtn.title = 'session キャッシュからコピー';
        copyPwBtn.style.fontSize = '11px';
        copyPwBtn.onclick = () => copyText(cached);
        pwForm.appendChild(pwLabel);
        pwForm.appendChild(pwStatus);
        pwForm.appendChild(pwRevealValue);
        pwForm.appendChild(revealBtn);
        pwForm.appendChild(copyPwBtn);
      } else if (r.passwordHash) {
        // 保存済 → reveal 不可．notice
        const notice = document.createElement('span');
        notice.textContent = '(保存済パスワードは再表示できません)';
        notice.style.fontSize = '10px';
        notice.style.color = 'var(--muted)';
        pwForm.appendChild(pwLabel);
        pwForm.appendChild(pwStatus);
        pwForm.appendChild(notice);
      } else {
        pwForm.appendChild(pwLabel);
        pwForm.appendChild(pwStatus);
      }
      // パスワード設定/変更フォーム (常時)
      const pwInput = document.createElement('input');
      pwInput.type = 'text';
      pwInput.placeholder = r.passwordHash ? '新パスワードに変更．空で削除' : '4 文字以上．空欄で削除';
      pwInput.style.width = '180px';
      pwInput.style.fontSize = '12px';
      const pwSetBtn = document.createElement('button');
      pwSetBtn.textContent = '設定';
      pwSetBtn.onclick = async () => {
        try {
          const result = await api('/rooms/' + encodeURIComponent(r.id) + '/password', {
            method: 'PUT',
            body: JSON.stringify({ password: pwInput.value }),
          });
          // B3: displayedOnce があれば session キャッシュ
          if (result.displayedOnce) {
            sessionStorage.setItem(PW_CACHE_KEY, result.displayedOnce);
          } else {
            sessionStorage.removeItem(PW_CACHE_KEY);
          }
          pwInput.value = '';
          await loadRooms();
        } catch (e) { showError('パスワード設定失敗: ' + e.message); }
      };
      pwForm.appendChild(pwInput);
      pwForm.appendChild(pwSetBtn);
      inv.appendChild(pwForm);

      if (r.invitations?.length) {
        const t = document.createElement('table');
        t.innerHTML = '<tr><th>メアド</th><th>ロール</th><th>登録</th><th>招待 URL (token)</th><th></th></tr>';
        r.invitations.forEach((i) => {
          const tr = document.createElement('tr');
          tr.innerHTML =
            '<td>' + escapeHtml(i.email) + '</td>' +
            '<td><span class="pill invite">' + (i.role ?? 'editor') + '</span></td>' +
            '<td>' + (i.invitedAt ? new Date(i.invitedAt).toLocaleString('ja-JP') : '') + '</td>';
          // B3 (2026-06-09): token reveal + 招待 URL 自動生成 (runtime URL から)
          const tokTd = document.createElement('td');
          if (i.token) {
            // デフォルト隠し ●●●●●●●●
            const tokSpan = document.createElement('code');
            tokSpan.textContent = '●●●●●●●●';
            tokSpan.style.fontSize = '11px';
            tokSpan.style.color = '#666';
            const revealBtn = document.createElement('button');
            revealBtn.textContent = '👁';
            revealBtn.title = 'token を全表示';
            revealBtn.style.fontSize = '11px';
            let shown = false;
            revealBtn.onclick = () => {
              shown = !shown;
              tokSpan.textContent = shown ? i.token : '●●●●●●●●';
              tokSpan.style.color = shown ? '#333' : '#666';
              revealBtn.textContent = shown ? '🙈' : '👁';
            };
            const copyBtn = document.createElement('button');
            copyBtn.textContent = '📋';
            copyBtn.title = 'token をコピー';
            copyBtn.style.fontSize = '11px';
            copyBtn.onclick = () => {
              copyText(i.token);
              copyBtn.textContent = '✓'; setTimeout(() => copyBtn.textContent = '📋', 1500);
            };
            // 招待 URL 自動生成: runtime.json から最良 host を選ぶ
            const urlBtn = document.createElement('button');
            urlBtn.textContent = '🔗 URL';
            urlBtn.title = 'runtime URL (Cloudflare/LAN) から招待 URL を生成してコピー';
            urlBtn.style.fontSize = '11px';
            urlBtn.onclick = async () => {
              try {
                const rt = await api('/server/runtime');
                let host = null;
                if (rt.cloudflareUrl) host = rt.cloudflareUrl.replace(/^https:/, 'wss:');
                else if (rt.lanUrls && rt.lanUrls.length > 0) {
                  const m = rt.lanUrls[0].match(/^(ws:\/\/[^\s]+)/);
                  host = m ? m[1] : null;
                }
                if (!host) {
                  host = prompt('共有 URL のホスト (例: wss://xxx.trycloudflare.com)', 'ws://localhost:1234');
                  if (!host) return;
                }
                const url = host.replace(/\/$/, '') + '/' + encodeURIComponent(r.id) +
                  '?t=' + i.token + '&nick=' + encodeURIComponent(i.email.split('@')[0]);
                await copyText(url);
                urlBtn.textContent = '✓ URL';
                setTimeout(() => urlBtn.textContent = '🔗 URL', 2000);
              } catch (e) { showError('URL 生成失敗: ' + e.message); }
            };
            const rotateBtn = document.createElement('button');
            rotateBtn.textContent = '↻';
            rotateBtn.title = 'token を再発行 (漏洩時)';
            rotateBtn.style.fontSize = '11px';
            rotateBtn.onclick = async () => {
              if (!confirm(i.email + ' の招待 token を再発行しますか？\n旧 URL は無効になります．')) return;
              try {
                await api('/rooms/' + encodeURIComponent(r.id) + '/invitations/' + encodeURIComponent(i.email) + '/rotate', { method: 'POST' });
                await loadRooms();
              } catch (e) { showError('rotate 失敗: ' + e.message); }
            };
            tokTd.appendChild(tokSpan);
            tokTd.appendChild(document.createTextNode(' '));
            tokTd.appendChild(revealBtn);
            tokTd.appendChild(copyBtn);
            tokTd.appendChild(urlBtn);
            tokTd.appendChild(rotateBtn);
          } else {
            tokTd.innerHTML = '<span class="muted">なし</span>';
          }
          tr.appendChild(tokTd);
          const td = document.createElement('td');
          const rev = document.createElement('button');
          rev.className = 'danger'; rev.textContent = '削除';
          rev.onclick = async () => {
            if (!confirm(i.email + ' を招待リストから削除しますか？')) return;
            try {
              await api('/rooms/' + encodeURIComponent(r.id) + '/invitations/' + encodeURIComponent(i.email), { method: 'DELETE' });
              await loadRooms();
            } catch (e) { showError('削除失敗: ' + e.message); }
          };
          td.appendChild(rev); tr.appendChild(td);
          t.appendChild(tr);
        });
        inv.appendChild(t);
      }
      main.appendChild(inv);

      // B5' (2026-06-09): per-room 認証ポリシー section
      const ap = document.createElement('section');
      ap.innerHTML = '<h3>認証ポリシー (per-room)</h3>';
      const apBody = document.createElement('div');
      ap.appendChild(apBody);
      main.appendChild(ap);
      renderRoomAuthPolicy(apBody, r.id);

      // 監査
      if (r.auditLogging === 'on') {
        const aud = document.createElement('section');
        aud.innerHTML = '<h3>監査ログ</h3>';
        const log = document.createElement('div');
        log.className = 'log';
        log.textContent = '読み込み中...';
        aud.appendChild(log);
        main.appendChild(aud);
        try {
          const events = await api('/rooms/' + encodeURIComponent(r.id) + '/audit');
          if (!events.length) {
            log.textContent = '(まだイベントはありません)';
          } else {
            log.textContent = events
              .slice(-200)
              .map(e =>
                e.timestamp + '  ' + (e.event || '').padEnd(14) +
                ' user=' + (e.user || '-') +
                ' nick=' + (e.nick || '-') +
                (e.bytes ? ' bytes=' + e.bytes : '') +
                (e.reason ? ' reason=' + e.reason : '')
              )
              .join('\n');
          }
        } catch (e) { log.textContent = '取得失敗: ' + e.message; }
      }
    }

    async function updateRoom(patch) {
      try {
        await api('/rooms/' + encodeURIComponent(selectedId), {
          method: 'PATCH',
          body: JSON.stringify(patch),
        });
        await loadRooms();
      } catch (e) { showError('更新失敗: ' + e.message); }
    }

    async function deleteRoom(id) {
      if (!confirm('ルーム "' + id + '" を削除しますか？このルームの Y.Doc 履歴も完全に消えます．')) return;
      try {
        await api('/rooms/' + encodeURIComponent(id), { method: 'DELETE' });
        selectedId = null;
        await loadRooms();
      } catch (e) { showError('削除失敗: ' + e.message); }
    }

    // ----- form helpers -----
    function formRow(label, value, readonly) {
      const row = document.createElement('div'); row.className = 'row';
      const l = document.createElement('label'); l.textContent = label;
      const v = document.createElement('span'); v.textContent = value; v.style.fontFamily = 'monospace';
      row.appendChild(l); row.appendChild(v);
      return row;
    }
    function textInput(label, value, onChange) {
      const row = document.createElement('div'); row.className = 'row';
      const l = document.createElement('label'); l.textContent = label;
      const i = document.createElement('input'); i.value = value; i.style.width = '240px';
      const btn = document.createElement('button'); btn.textContent = '保存';
      btn.onclick = () => onChange(i.value);
      row.appendChild(l); row.appendChild(i); row.appendChild(btn);
      return row;
    }
    function selectInput(label, value, options, onChange) {
      const row = document.createElement('div'); row.className = 'row';
      const l = document.createElement('label'); l.textContent = label;
      const s = document.createElement('select');
      options.forEach((opt) => {
        const o = document.createElement('option'); o.value = opt; o.textContent = opt;
        if (opt === value) o.selected = true;
        s.appendChild(o);
      });
      s.onchange = () => onChange(s.value);
      row.appendChild(l); row.appendChild(s);
      return row;
    }

    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function formatBytes(n) {
      if (!Number.isFinite(n) || n < 0) return '?';
      if (n < 1024) return n + ' B';
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
      if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
      return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
    }

    // -------- new-room dialog (modal form) --------
    document.getElementById('newRoomBtn').onclick = () => openNewRoomDialog();

    function openNewRoomDialog() {
      const back = document.createElement('div');
      back.className = 'modal-backdrop';
      back.innerHTML = `
        <div class="modal">
          <h2>新しいルームを追加</h2>
          <div class="field">
            <label>ID（変更不可．英数字・ハイフン推奨）</label>
            <input type="text" id="mId" placeholder="kjlab2026" />
            <div class="hint">クライアントが接続時に指定するキー．例 ws://host:1234/<b>kjlab2026</b></div>
          </div>
          <div class="field">
            <label>表示名</label>
            <input type="text" id="mName" placeholder="KJ Lab 2026" />
          </div>
          <div class="field">
            <label>接続制御</label>
            <div class="field-radio">
              <label><input type="radio" name="mAccess" value="open" checked /> open (誰でも接続可)</label>
              <label><input type="radio" name="mAccess" value="invite_list" /> invite_list (招待メアドのみ)</label>
            </div>
          </div>
          <div class="field">
            <label>監査ログ</label>
            <div class="field-radio">
              <label><input type="radio" name="mAudit" value="off" checked /> off</label>
              <label><input type="radio" name="mAudit" value="on" /> on (接続・編集を記録)</label>
            </div>
          </div>
          <div class="modal-actions">
            <button id="mCancel">キャンセル</button>
            <button id="mCreate" class="primary">作成</button>
          </div>
        </div>`;
      document.body.appendChild(back);

      const close = () => back.remove();
      back.addEventListener('click', (e) => { if (e.target === back) close(); });
      back.querySelector('#mCancel').onclick = close;
      back.querySelector('#mId').focus();

      back.querySelector('#mCreate').onclick = async () => {
        const id = back.querySelector('#mId').value.trim();
        if (!id) { showError('ID は必須'); return; }
        if (!/^[A-Za-z0-9._-]+$/.test(id)) {
          showError('ID は英数字 / . _ - のみにしてください');
          return;
        }
        const name = back.querySelector('#mName').value.trim() || id;
        const access = back.querySelector('input[name="mAccess"]:checked').value;
        const audit = back.querySelector('input[name="mAudit"]:checked').value;
        try {
          await api('/rooms', {
            method: 'POST',
            body: JSON.stringify({ id, name, access, audit }),
          });
          close();
          selectedId = id;
          await loadRooms();
        } catch (e) { showError('作成失敗: ' + e.message); }
      };
    }

    document.getElementById('refreshBtn').onclick = () => { loadRooms(); loadPresence(); loadServerConfig(); };

    // -------- 公開方式 (server config) --------
    async function loadServerConfig() {
      try {
        const data = await api('/server/config');
        renderServerConfig(data);
      } catch (e) {
        document.getElementById('serverConfigPanel').innerHTML =
          '<div class="empty">取得失敗: ' + escapeHtml(e.message) + '</div>';
      }
    }
    function renderServerConfig(data) {
      const cur = data.current;
      const panel = document.getElementById('serverConfigPanel');
      panel.innerHTML = '';

      // 現状表示
      const status = document.createElement('div');
      const presetName = cur.preset.name;
      const presetLabel = cur.preset.label ?? '';
      status.innerHTML =
        '<div><strong>現在:</strong> ' + escapeHtml(presetName) + ' (' + escapeHtml(presetLabel) + ')</div>' +
        '<div class="muted small">' + escapeHtml(cur.preset.description ?? '') + '</div>' +
        '<div class="muted small">app: ' + escapeHtml(cur.network.appBindHost + ':' + cur.network.appPort) + '</div>' +
        '<div class="muted small">admin: ' + escapeHtml(cur.network.adminBindHost + ':' + cur.network.adminPort) + '</div>' +
        '<div class="muted small">認証: ' + cur.auth.providers.map(escapeHtml).join(', ') + '</div>';
      panel.appendChild(status);

      // 警告
      if (cur.warnings && cur.warnings.length > 0) {
        const w = document.createElement('div');
        w.style.cssText = 'background:#fff3cd;border:1px solid #e0b34c;padding:6px;border-radius:4px;margin-top:6px;font-size:11px;color:#856404;';
        w.innerHTML = '<strong>⚠ 警告:</strong><ul style="margin:4px 0 0 16px;padding:0;">' +
          cur.warnings.map((x) => '<li>' + escapeHtml(x) + '</li>').join('') +
          '</ul>';
        panel.appendChild(w);
      }

      // プリセット選択ボタン
      const heading = document.createElement('div');
      heading.style.cssText = 'margin-top:10px;font-weight:600;font-size:11px;';
      heading.textContent = 'プリセット変更:';
      panel.appendChild(heading);

      const presetList = document.createElement('div');
      presetList.style.cssText = 'display:flex;flex-direction:column;gap:4px;margin-top:4px;';
      data.availablePresets.forEach((p) => {
        const card = document.createElement('div');
        const isCurrent = p.name === presetName;
        card.style.cssText = 'padding:6px 8px;border:1px solid var(--border);border-radius:4px;cursor:pointer;font-size:11px;' +
          (isCurrent ? 'background:#e8f0fb;border-color:#5a90c8;' : '');
        card.innerHTML =
          '<div><strong>' + escapeHtml(p.label ?? p.name) + '</strong>' +
          (p.requireAuth ? ' <span class="pill" style="background:#fde7c8;color:#8a6020;">認証必須</span>' : '') +
          (isCurrent ? ' <span style="color:#2a8;font-size:10px;">適用中</span>' : '') +
          '</div>' +
          '<div class="muted" style="font-size:10px;margin-top:2px;">' + escapeHtml(p.description ?? '') + '</div>';
        if (!isCurrent) {
          card.onmouseenter = () => { card.style.background = '#f5f7fa'; };
          card.onmouseleave = () => { card.style.background = ''; };
          card.onclick = async () => {
            if (!confirm(`プリセットを「${p.label ?? p.name}」に切り替えますか？\n\n${p.description ?? ''}\n\n変更を反映するにはサーバー再起動が必要です．`)) return;
            try {
              await api('/server/config/preset', {
                method: 'PUT',
                body: JSON.stringify({ preset: p.name }),
              });
              showError('プリセットを ' + p.name + ' に保存しました．サーバーを再起動してください．');
              setTimeout(() => location.reload(), 1500);
            } catch (e) { showError('プリセット切替失敗: ' + e.message); }
          };
        }
        presetList.appendChild(card);
      });
      panel.appendChild(presetList);
    }

    // -------- presence (5s polling) --------
    async function loadPresence() {
      try {
        const data = await api('/presence');
        renderPresence(data);
      } catch (e) {
        // Silently ignore — presence is best-effort
        document.getElementById('presenceList').innerHTML =
          '<div class="empty">取得失敗</div>';
      }
    }
    function renderPresence(data) {
      document.getElementById('presenceCount').textContent =
        '(' + data.totalConnections + ')';
      document.getElementById('presenceUpdated').textContent =
        '最終更新 ' + new Date().toLocaleTimeString('ja-JP');
      const el = document.getElementById('presenceList');
      const roomIds = Object.keys(data.rooms);
      if (!roomIds.length || data.totalConnections === 0) {
        el.innerHTML = '<div class="empty">誰も接続していません</div>';
        return;
      }
      el.innerHTML = '';
      roomIds.forEach((rid) => {
        const users = data.rooms[rid];
        if (!users.length) return;
        const div = document.createElement('div');
        div.className = 'presence-room';
        const head = document.createElement('div');
        head.className = 'pr-head';
        head.textContent = rid + ' (' + users.length + ')';
        div.appendChild(head);
        users.forEach((u) => {
          const chip = document.createElement('span');
          chip.className = 'presence-user';
          const label = u.nick || u.email || '(anonymous)';
          chip.textContent = label;
          chip.title =
            'nick: ' + (u.nick || '-') +
            '\nemail: ' + (u.email || '-') +
            '\nrole: ' + (u.role || '-') +
            '\nIP: ' + (u.ip || '-');
          div.appendChild(chip);
        });
        el.appendChild(div);
      });
    }

    // initial
    document.getElementById('serverMeta').textContent =
      'host=' + location.host;
    loadRooms();
    loadPresence();
    loadServerConfig();
    setInterval(loadPresence, 5000);


    // === B2 (2026-06-09) URL Dashboard + Tunnel ボタン ===
    async function copyText(text) {
      try {
        await navigator.clipboard.writeText(text);
      } catch (e) {
        prompt('コピーしてください:', text);
      }
    }

    function urlRow(label, url, options = {}) {
      const row = document.createElement('div');
      row.className = 'url-row';
      const lbl = document.createElement('span');
      lbl.className = 'url-label';
      lbl.textContent = label;
      const val = document.createElement('span');
      val.className = 'url-value' + (url ? '' : ' url-empty');
      val.textContent = url || '(未起動)';
      const actions = document.createElement('span');
      actions.className = 'url-actions';
      if (url) {
        const copyBtn = document.createElement('button');
        copyBtn.textContent = '📋 コピー';
        copyBtn.onclick = () => copyText(url);
        actions.appendChild(copyBtn);
      }
      if (options.extra) {
        for (const e of options.extra) actions.appendChild(e);
      }
      row.appendChild(lbl);
      row.appendChild(val);
      row.appendChild(actions);
      return row;
    }

    async function loadUrlDashboard() {
      try {
        const r = await fetch('/admin/api/server/runtime', {
          headers: { Authorization: 'Bearer ' + getToken() },
        });
        if (r.status === 401) { sessionStorage.removeItem(TOKEN_KEY); location.reload(); return; }
        const data = await r.json();
        const body = document.getElementById('urlDashboardBody');
        body.innerHTML = '';

        // 管理画面 URL (localhost)
        body.appendChild(urlRow('管理 (localhost)', data.adminUrl));

        // ローカル WebSocket
        body.appendChild(urlRow('ローカル (ws)', data.localhostWs));

        // LAN URLs
        if (data.lanUrls && data.lanUrls.length > 0) {
          for (const u of data.lanUrls) {
            const m = u.match(/^(ws:\/\/[^\s]+)\s*(\(.*\))?/);
            const wsUrl = m ? m[1] : u;
            const ifName = m && m[2] ? m[2] : '';
            const row = urlRow('LAN ' + ifName, wsUrl);
            body.appendChild(row);
          }
        } else {
          body.appendChild(urlRow('LAN', ''));
        }

        // Cloudflare
        const cfRow = (() => {
          const row = document.createElement('div');
          row.className = 'url-row';
          const lbl = document.createElement('span');
          lbl.className = 'url-label';
          lbl.textContent = 'Cloudflare';
          const val = document.createElement('span');
          val.className = 'url-value' + (data.cloudflareUrl ? '' : ' url-empty');
          val.textContent = data.cloudflareUrl || (data.cloudflaredPath ? '(未起動)' : '(cloudflared 未インストール)');
          const actions = document.createElement('span');
          actions.className = 'url-actions';
          if (data.cloudflareUrl) {
            const copyHttps = document.createElement('button');
            copyHttps.textContent = '📋 https://';
            copyHttps.onclick = () => copyText(data.cloudflareUrl);
            actions.appendChild(copyHttps);
            const copyWss = document.createElement('button');
            copyWss.textContent = '📋 wss://';
            copyWss.onclick = () => copyText(data.cloudflareUrl.replace(/^https:/, 'wss:'));
            actions.appendChild(copyWss);
            const stop = document.createElement('button');
            stop.textContent = '⏹ 停止';
            stop.className = 'danger';
            stop.onclick = () => tunnelStop();
            actions.appendChild(stop);
          } else if (data.cloudflaredPath) {
            const start = document.createElement('button');
            start.textContent = '▶ 起動 (Quick Tunnel)';
            start.className = 'primary';
            start.onclick = () => tunnelStart();
            actions.appendChild(start);
          } else {
            const inst = document.createElement('button');
            inst.textContent = '📋 winget install コマンド';
            inst.onclick = () => copyText('winget install --id Cloudflare.cloudflared -e');
            actions.appendChild(inst);
          }
          row.appendChild(lbl);
          row.appendChild(val);
          row.appendChild(actions);
          return row;
        })();
        body.appendChild(cfRow);

        // Warnings
        if (data.warnings && data.warnings.length > 0) {
          const w = document.createElement('div');
          w.className = 'url-warning';
          w.innerHTML = '<b>⚠ 警告:</b><br>' + data.warnings.map((x) => '・' + x).join('<br>');
          body.appendChild(w);
        }

        // section meta (uptime 等)
        const meta = document.getElementById('urlDashboardMeta');
        const pieces = [];
        if (data.cloudflareUrl) pieces.push('Cloudflare: 起動中');
        else if (data.cloudflaredPath) pieces.push('Cloudflare: 停止中');
        else pieces.push('cloudflared: 未インストール');
        meta.textContent = pieces.join('  /  ');
      } catch (e) {
        showError('runtime 読込エラー: ' + e.message);
      }
    }

    async function tunnelStart() {
      // R16 確認ダイアログ
      const ok = confirm(
        '⚠ Cloudflare Quick Tunnel を起動します．\n\n' +
        '・URL は毎回ランダム (デモ用)\n' +
        '・cloudflared 終了で URL が変わる\n' +
        '・7 日間の使用制限あり\n' +
        '・長期運用には Named Tunnel 推奨\n\n' +
        '起動しますか？'
      );
      if (!ok) return;
      try {
        const r = await fetch('/admin/api/tunnel/start', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + getToken(),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ target: 'app' }),
        });
        const j = await r.json();
        if (j.ok) {
          alert('起動成功:\n' + j.url);
          loadUrlDashboard();
        } else {
          showError('起動失敗: ' + (j.error || 'unknown'));
        }
      } catch (e) {
        showError('起動エラー: ' + e.message);
      }
    }

    async function tunnelStop() {
      if (!confirm('Cloudflare Tunnel を停止しますか？')) return;
      try {
        const r = await fetch('/admin/api/tunnel/stop', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + getToken() },
        });
        const j = await r.json();
        if (j.killed) alert('停止しました' + (j.graceful ? '' : ' (SIGKILL)'));
        else alert('停止しませんでした: ' + (j.reason || '不明'));
        loadUrlDashboard();
      } catch (e) {
        showError('停止エラー: ' + e.message);
      }
    }

    loadUrlDashboard();
    setInterval(loadUrlDashboard, 10000);

    // === B5' (2026-06-09) Auth Policy: シナリオ + Advanced matrix ===
    const AUTH_METHODS = [
      'inviteToken', 'roomPassword', 'trustedProxy', 'tailscale',
      'ipCidr', 'emailLegacy', 'noneOpen', 'localhostAuto',
    ];
    const AUTH_METHOD_LABELS = {
      inviteToken: '招待 token (?t=)',
      roomPassword: 'ルーム password (?pw=)',
      trustedProxy: 'reverse-proxy header',
      tailscale: 'Tailscale 自動 (100.64/10)',
      ipCidr: 'IP allowlist (CIDR)',
      emailLegacy: 'Email 自己申告 (legacy)',
      noneOpen: '認証なし (none-open)',
      localhostAuto: 'Localhost 自動 (127.0.0.1)',
    };

    let _scenarioState = { selected: null, currentPreset: null };

    async function loadAuthPolicySection() {
      try {
        const sc = await api('/scenarios');
        const cfg = await api('/server/config');
        _scenarioState.currentPreset = cfg.current?.preset?.name ?? 'custom';
        const body = document.getElementById('authPolicyBody');
        body.innerHTML = '';

        // ヘッダ + 説明
        const intro = document.createElement('div');
        intro.className = 'muted small';
        intro.style.marginBottom = '6px';
        intro.textContent = '現在の preset: ' + _scenarioState.currentPreset + '．シナリオを変更すると preset + 推奨設定が適用されます (要再起動)．';
        body.appendChild(intro);

        // シナリオグリッド
        const grid = document.createElement('div');
        grid.className = 'scenario-grid';
        for (const s of sc.scenarios) {
          const card = document.createElement('div');
          card.className = 'scenario-card';
          if (s.preset === _scenarioState.currentPreset) card.classList.add('selected');
          const t = document.createElement('div');
          t.className = 'scenario-title';
          t.textContent = s.label;
          const d = document.createElement('div');
          d.className = 'scenario-desc';
          d.textContent = s.description;
          const p = document.createElement('div');
          p.className = 'scenario-preset';
          p.textContent = 'preset = ' + s.preset;
          card.appendChild(t);
          card.appendChild(d);
          card.appendChild(p);
          card.onclick = () => applyScenario(s);
          grid.appendChild(card);
        }
        body.appendChild(grid);

        // Meta
        const sel = sc.scenarios.find((x) => x.preset === _scenarioState.currentPreset);
        const meta = document.getElementById('authPolicyMeta');
        meta.textContent = sel ? sel.label : ('preset: ' + _scenarioState.currentPreset);
      } catch (e) {
        showError('シナリオ読込エラー: ' + e.message);
      }
    }

    async function applyScenario(s) {
      if (!confirm(
        '次のシナリオを適用しますか？\n\n' +
        s.label + '\n' + s.description + '\n\n' +
        '・preset を ' + s.preset + ' に変更\n' +
        '・config/server.json を書き換え\n' +
        '・反映には再起動が必要 (現在の接続は維持)'
      )) return;
      try {
        await api('/scenarios/' + encodeURIComponent(s.id) + '/apply', { method: 'POST' });
        alert('シナリオを適用しました: ' + s.label + '\n\nサーバーを再起動してください．');
        loadAuthPolicySection();
        loadServerConfig();
      } catch (e) {
        showError('シナリオ適用エラー: ' + e.message);
      }
    }

    // Per-room auth matrix (Advanced toggle 内で使用)
    async function renderRoomAuthPolicy(container, roomId) {
      try {
        const ap = await api('/rooms/' + encodeURIComponent(roomId) + '/auth-policy');
        container.innerHTML = '';

        // Validation 表示
        if (ap.validation) {
          if (ap.validation.errors.length > 0) {
            const box = document.createElement('div');
            box.className = 'validation-box errors';
            box.innerHTML = '<b>❌ 保存できない組合せ:</b><ul>' +
              ap.validation.errors.map((e) => '<li>' + escapeHtml(e) + '</li>').join('') + '</ul>';
            container.appendChild(box);
          }
          if (ap.validation.warnings.length > 0) {
            const box = document.createElement('div');
            box.className = 'validation-box warnings';
            box.innerHTML = '<b>⚠ 警告:</b><ul>' +
              ap.validation.warnings.map((w) => '<li>' + escapeHtml(w) + '</li>').join('') + '</ul>';
            container.appendChild(box);
          }
        }

        // Advanced matrix トグル
        const toggle = document.createElement('a');
        toggle.className = 'advanced-toggle';
        toggle.textContent = '▶ 詳細設定 (per-room 認証マトリクス) を表示';
        const matrixDiv = document.createElement('div');
        matrixDiv.style.display = 'none';
        let shown = false;
        toggle.onclick = () => {
          shown = !shown;
          matrixDiv.style.display = shown ? '' : 'none';
          toggle.textContent = shown ? '▼ 詳細設定 (per-room 認証マトリクス) を隠す' : '▶ 詳細設定 (per-room 認証マトリクス) を表示';
        };
        container.appendChild(toggle);

        // Matrix table
        const t = document.createElement('table');
        t.className = 'auth-matrix';
        let html = '<tr><th>Provider</th><th>per-room</th><th>→ effective</th></tr>';
        for (const name of AUTH_METHODS) {
          const raw = ap.raw?.authMethods?.[name] ?? 'inherit';
          const eff = ap.effective?.authMethods?.[name];
          const effLabel = eff ? '<span class="eff-on">ON</span>' : '<span class="eff-off">OFF</span>';
          html += '<tr>' +
            '<td>' + AUTH_METHOD_LABELS[name] + '<br><code>' + name + '</code></td>' +
            '<td><select data-method="' + name + '">' +
              '<option value="on"' + (raw === 'on' ? ' selected' : '') + '>on</option>' +
              '<option value="off"' + (raw === 'off' ? ' selected' : '') + '>off</option>' +
              '<option value="inherit"' + (raw === 'inherit' ? ' selected' : '') + '>inherit</option>' +
            '</select></td>' +
            '<td>' + effLabel + '</td>' +
          '</tr>';
        }
        // requirementGroups summary
        const rg = (ap.effective?.requirementGroups ?? []).map((g) => '[' + g.join(' OR ') + ']').join(' AND ');
        html += '<tr><th colspan="3" style="background:#eee;">必須条件 (requirementGroups)</th></tr>' +
          '<tr><td colspan="3"><code>' + (rg || '(なし — loose mode)') + '</code></td></tr>';
        t.innerHTML = html;
        matrixDiv.appendChild(t);

        // Save button
        const saveBtn = document.createElement('button');
        saveBtn.textContent = '認証ポリシーを保存';
        saveBtn.className = 'primary';
        saveBtn.style.marginTop = '8px';
        saveBtn.disabled = ap.validation?.errors?.length > 0;
        saveBtn.onclick = async () => {
          const newMethods = {};
          for (const sel of t.querySelectorAll('select[data-method]')) {
            newMethods[sel.dataset.method] = sel.value;
          }
          try {
            await api('/rooms/' + encodeURIComponent(roomId), {
              method: 'PATCH',
              body: JSON.stringify({ authPolicy: { authMethods: newMethods } }),
            });
            renderRoomAuthPolicy(container, roomId);
          } catch (e) { showError('保存失敗: ' + e.message); }
        };
        matrixDiv.appendChild(saveBtn);
        container.appendChild(matrixDiv);
      } catch (e) {
        container.innerHTML = '<div class="muted">auth-policy 読込エラー: ' + escapeHtml(e.message) + '</div>';
      }
    }

    loadAuthPolicySection();