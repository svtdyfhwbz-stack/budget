/* =============================================================
   sync.js — Multi-account + session + GitHub sync + Mobile mode
   ============================================================= */
(function () {
'use strict';

const ACCOUNTS_KEY    = 'budget_accounts_v2';
const SESSION_KEY     = 'budget_session_v2';
const LOADED_USER_KEY = 'budget_loaded_user_v2';
const PENDING_GH_KEY  = 'budget_pending_gh_v1';
const DATA_PREFIX     = 'budget_data_';
const GH_PREFIX       = 'budget_gh_';
const GH_API          = 'https://api.github.com';
const ACCOUNTS_FILE   = 'accounts.json';
const MOBILE_MODE_KEY = 'budget_mobile_mode_v1';

let currentUser = null;
let ghSha = null;
let ghPushTimer = null;
let ghAccountsTimer = null;
let ghSyncing = false;
let booted = false;
let pushInFlight = false;

/* ---------- storage ---------- */
function accounts() {
  try { return JSON.parse(localStorage.getItem(ACCOUNTS_KEY) || '{}'); }
  catch { return {}; }
}
function saveAccounts(a) {
  localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(a));
  schedulePushAccounts();
}
function session() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); }
  catch { return null; }
}
function saveSession(s) {
  if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  else localStorage.removeItem(SESSION_KEY);
}
function loadedUser() { return localStorage.getItem(LOADED_USER_KEY) || null; }
function setLoadedUser(u) {
  if (u) localStorage.setItem(LOADED_USER_KEY, u);
  else localStorage.removeItem(LOADED_USER_KEY);
}
function pendingGh() {
  try { return JSON.parse(localStorage.getItem(PENDING_GH_KEY) || 'null'); }
  catch { return null; }
}
function setPendingGh(v) {
  if (v) localStorage.setItem(PENDING_GH_KEY, JSON.stringify(v));
  else localStorage.removeItem(PENDING_GH_KEY);
}
function dataKey(u) { return DATA_PREFIX + u; }
function ghKey(u)   { return GH_PREFIX + u; }
function loadUserData(u) {
  try { return JSON.parse(localStorage.getItem(dataKey(u)) || 'null'); }
  catch { return null; }
}
function saveUserData(u, data) {
  try { localStorage.setItem(dataKey(u), JSON.stringify(data)); }
  catch (e) { console.warn('saveUserData failed', e); }
}
function ghCfg(u) {
  u = u || currentUser;
  if (!u) return {};
  try { return JSON.parse(localStorage.getItem(ghKey(u)) || '{}'); }
  catch { return {}; }
}
function ghSaveCfg(cfg, u) {
  u = u || currentUser;
  if (!u) return;
  localStorage.setItem(ghKey(u), JSON.stringify(cfg));
}

/* ---------- crypto ---------- */
async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
function utf8ToB64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function b64ToUtf8(b64) {
  const bin = atob((b64 || '').replace(/\n/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/* ---------- GH API ---------- */
async function ghFetchRaw(method, url, body, token) {
  const headers = {
    'Authorization': 'Bearer ' + token,
    'Accept': 'application/vnd.github.v3+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  if (body) headers['Content-Type'] = 'application/json';
  const r = await fetch(GH_API + url, {
    method, headers,
    body: body ? JSON.stringify(body) : undefined
  });
  if (r.status === 404) return null;
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error('GitHub ' + r.status + ': ' + txt.slice(0, 300));
  }
  return r.json();
}
async function ghFetch(method, url, body) {
  const cfg = ghCfg();
  if (!cfg.token) throw new Error('Токен не задан');
  return ghFetchRaw(method, url, body, cfg.token);
}

/* ---------- atomic file write ---------- */
function parseCurrentSha(msg) {
  const m = String(msg || '').match(/is at ([0-9a-f]{40})/i);
  return m ? m[1] : null;
}
async function ghGetFile(path, cfg, rawToken) {
  const branch = cfg.branch || 'main';
  const url = `/repos/${cfg.user}/${cfg.repo}/contents/${path}?ref=${branch}&cb=${Date.now()}-${Math.random()}`;
  try {
    if (rawToken) return await ghFetchRaw('GET', url, null, rawToken);
    return await ghFetch('GET', url);
  } catch (e) { return null; }
}
async function ghAtomicPut(path, contentB64, message, cfg) {
  const branch = cfg.branch || 'main';
  const url = `/repos/${cfg.user}/${cfg.repo}/contents/${path}`;
  let shaHint = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    let sha = shaHint;
    shaHint = null;
    if (!sha) {
      const j = await ghGetFile(path, cfg);
      if (j && j.sha) sha = j.sha;
    }
    const body = { message, content: contentB64, branch };
    if (sha) body.sha = sha;
    try {
      const r = await ghFetch('PUT', url, body);
      if (r && r.content) return { ok: true, sha: r.content.sha };
    } catch (e) {
      const msg = String((e && e.message) || '');
      const isConflict = msg.includes('409') || msg.includes('422') ||
                         msg.includes('does not match') ||
                         msg.includes("sha wasn't supplied");
      if (isConflict) {
        shaHint = parseCurrentSha(msg);
        const wait = 400 * Math.pow(1.6, attempt) + Math.random() * 900;
        console.warn('atomic put conflict #' + attempt, 'hint=' + shaHint, 'wait=' + Math.round(wait));
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw e;
    }
  }
  console.warn('atomic put: max retries for ' + path);
  return { ok: false };
}

/* ---------- accounts.json ---------- */
async function pushAccountsFile() {
  const cfg = ghCfg();
  if (!cfg.token || !cfg.user || !cfg.repo) return false;
  const content = utf8ToB64(JSON.stringify(accounts(), null, 2));
  const res = await ghAtomicPut(ACCOUNTS_FILE, content, 'accounts sync', cfg);
  return !!res.ok;
}
function schedulePushAccounts() {
  if (!currentUser) return;
  const cfg = ghCfg();
  if (!cfg.token || !cfg.user || !cfg.repo) return;
  if (ghAccountsTimer) clearTimeout(ghAccountsTimer);
  ghAccountsTimer = setTimeout(pushAccountsFile, 3000 + Math.random() * 3000);
}
async function pullAccountsFile(user, repo, token, branch) {
  try {
    const url = `/repos/${user}/${repo}/contents/${ACCOUNTS_FILE}?ref=${branch || 'main'}&cb=${Date.now()}`;
    const j = await ghFetchRaw('GET', url, null, token);
    if (!j) return null;
    return JSON.parse(b64ToUtf8(j.content));
  } catch (e) {
    console.warn('pullAccountsFile error', e);
    return null;
  }
}

/* ---------- data.json ---------- */
async function ghPull() {
  const cfg = ghCfg();
  if (!cfg.token || !cfg.user || !cfg.repo) return null;
  const path = cfg.path || 'data.json';
  const j = await ghGetFile(path, cfg);
  if (!j) return null;
  try { return { data: JSON.parse(b64ToUtf8(j.content)), sha: j.sha }; }
  catch (e) { console.warn('ghPull parse error', e); return null; }
}
async function ghPush(message) {
  if (pushInFlight) { console.warn('push already in flight, skip'); return false; }
  pushInFlight = true;
  try {
    const cfg = ghCfg();
    if (!cfg.token || !cfg.user || !cfg.repo) return false;
    const path = cfg.path || 'data.json';
    state.lastModified = new Date().toISOString();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    saveUserData(currentUser, state);
    const remote = await ghGetFile(path, cfg);
    if (remote && remote.content) {
      try {
        const serverData = JSON.parse(b64ToUtf8(remote.content));
        const rt = new Date(serverData.lastModified || 0).getTime();
        const lt = new Date(state.lastModified || 0).getTime();
        if (rt > lt + 3000) {
          state = Object.assign(defaultState(), serverData);
          localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
          saveUserData(currentUser, state);
          if (typeof renderAll === 'function') renderAll();
          if (typeof toast === 'function') toast('Данные с сервера свежее — загружены', 'ok');
          return false;
        }
      } catch (e) {}
    }
    const content = utf8ToB64(JSON.stringify(state, null, 2));
    const msg = message || ('sync ' + new Date().toISOString());
    const res = await ghAtomicPut(path, content, msg, cfg);
    if (res.ok) {
      ghSha = res.sha;
      cfg.lastSync = new Date().toLocaleString('ru-RU');
      ghSaveCfg(cfg);
      return true;
    }
    return false;
  } finally {
    pushInFlight = false;
  }
}
async function ghPullAndMerge() {
  if (ghSyncing) return;
  ghSyncing = true;
  try {
    const remote = await ghPull();
    if (!remote) return;
    ghSha = remote.sha;
    const rt = new Date((remote.data && remote.data.lastModified) || 0).getTime();
    const lt = new Date((state && state.lastModified) || 0).getTime();
    if (rt > lt) {
      state = Object.assign(defaultState(), remote.data);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      saveUserData(currentUser, state);
      if (typeof renderAll === 'function') renderAll();
      if (typeof toast === 'function') toast('Загружено с GitHub', 'ok');
    }
  } catch (e) {
    console.warn('gh pull error', e);
  } finally {
    ghSyncing = false;
  }
}
async function ghPushNow(message) {
  try {
    const ok = await ghPush(message);
    if (ok && typeof toast === 'function') toast('Отправлено на GitHub', 'ok');
    ghUpdateStatus();
  } catch (e) {
    console.warn('gh push error', e);
    if (typeof toast === 'function') toast('Ошибка синхронизации: ' + e.message, 'err');
  }
}
function ghSchedulePush() {
  if (ghPushTimer) clearTimeout(ghPushTimer);
  ghPushTimer = setTimeout(() => {
    if (ghCfg().token) ghPushNow('auto');
  }, 5000 + Math.random() * 5000);
}

/* ---------- persist hook ---------- */
function hookPersist() {
  if (typeof persist !== 'function') { setTimeout(hookPersist, 200); return; }
  if (persist.__ghHooked) return;
  const orig = persist;
  window.persist = async function (options) {
    const r = await orig.call(this, options || {});
    if (currentUser) { try { saveUserData(currentUser, state); } catch (e) {} }
    if (!options || !options.skipSync) ghSchedulePush();
    return r;
  };
  window.persist.__ghHooked = true;
}

/* ============================================================
   ACCOUNTS RE-RENDER — показ в родной валюте счёта
   ============================================================ */
function renderAccountsNative() {
  const grid = document.getElementById('acc-grid');
  if (!grid) return;
  if (state.accounts.length === 0) {
    grid.innerHTML = `<div class="empty" style="grid-column:1/-1"><div class="big">＄</div>Пока нет счетов</div>`;
    return;
  }
  const base = state.settings.baseCurrency;
  const typeLabelFn = (typeof typeLabel === 'function') ? typeLabel : (t) => t;

  grid.innerHTML = state.accounts.map(a => {
    let nativeVal = 0, nativeCur = base;
    if (a.type === 'cash' || a.type === 'bank') {
      nativeVal = cashAccountBalance(a);
      nativeCur = a.currency || base;
    } else if (a.type === 'crypto') {
      nativeVal = cryptoAccountValue(a);
      nativeCur = (a.crypto && a.crypto.currency) || base;
    } else if (a.type === 'stocks') {
      nativeVal = stocksAccountValue(a);
      nativeCur = a.currency || 'USD';
    }
    const baseVal = accountValue(a);
    const showBase = nativeCur !== base;

    let meta = '';
    if (a.type === 'crypto') {
      const addr = a.crypto && a.crypto.address;
      meta = `${(a.crypto && a.crypto.network) || ''} · валюта: ${nativeCur} · `
        + (addr ? addr.slice(0, 6) + '…' + addr.slice(-4) : 'адрес не указан')
        + `<br>${a.crypto && a.crypto.lastUpdated ? 'обновлено ' + new Date(a.crypto.lastUpdated).toLocaleTimeString('ru-RU') : 'ещё не обновлялось'}`;
    } else if (a.type === 'stocks') {
      meta = `${(a.holdings || []).length} позиций · валюта: ${nativeCur}`;
    } else {
      meta = nativeCur;
    }

    return `<div class="acc-card" style="--c:${a.color}">
      <div class="head">
        <div><div class="name">${a.name}</div><div class="type">${typeLabelFn(a.type)}</div></div>
        <div class="row-actions" style="opacity:1;">
          <button class="icon-btn" onclick="openAccModal(accById('${a.id}'))">✎</button>
          <button class="icon-btn" onclick="deleteAccount('${a.id}')">✕</button>
        </div>
      </div>
      <div class="bal">${fmt(nativeVal, nativeCur)}</div>
      ${showBase ? `<div class="meta" style="font-size:11.5px;color:var(--text-dim);margin-top:2px;">≈ ${fmt(baseVal)}</div>` : ''}
      <div class="meta">${meta}</div>
      <div class="foot">
        ${a.type === 'crypto' ? `<button class="btn ghost small" onclick="refreshCrypto('${a.id}')">↻ Обновить курс</button>` : ''}
        ${a.type === 'stocks' ? `<button class="btn ghost small" onclick="showView('stocks')">Портфель →</button>` : '<span></span>'}
      </div>
    </div>`;
  }).join('');
}

/* ============================================================
   MOBILE MODE
   ============================================================ */
function isMobileDevice() {
  if (window.matchMedia && window.matchMedia('(max-width: 760px)').matches) return true;
  return /Android|iPhone|iPad|iPod|Opera Mini|IEMobile|WPDesktop/i.test(navigator.userAgent);
}
function mobilePref() { return localStorage.getItem(MOBILE_MODE_KEY) || 'auto'; }
function isMobileMode() {
  if (!isMobileDevice()) return false;
  return mobilePref() !== 'off';
}
function setMobileMode(on) {
  localStorage.setItem(MOBILE_MODE_KEY, on ? 'on' : 'off');
  applyMobileMode();
}

function injectMobileCSS() {
  if (document.getElementById('mobile-mode-css')) return;
  const style = document.createElement('style');
  style.id = 'mobile-mode-css';
  style.textContent = `
    body.mobile-mode .sidebar { display: none !important; }
    body.mobile-mode .main { padding: 14px 12px 100px; max-width: 100%; }
    body.mobile-mode .view { display: none !important; }
    body.mobile-mode #view-transactions { display: block !important; }
    body.mobile-mode #view-transactions .page-head {
      display: flex; align-items: center; justify-content: space-between;
      margin-bottom: 12px; padding-right: 110px;
    }
    body.mobile-mode #view-transactions .page-head h1 { font-size: 18px; }
    body.mobile-mode #view-transactions .page-head .sub { display: none; }
    body.mobile-mode #view-transactions #add-tx-btn { display: none !important; }
    body.mobile-mode #view-transactions .card { border-radius: 14px; padding: 10px; }
    body.mobile-mode #tx-table th:nth-child(2),
    body.mobile-mode #tx-table th:nth-child(4),
    body.mobile-mode #tx-table td:nth-child(2),
    body.mobile-mode #tx-table td:nth-child(4) { display: none; }
    body.mobile-mode #tx-table td,
    body.mobile-mode #tx-table th { padding: 8px 6px; font-size: 12.5px; }
    body.mobile-mode #tx-table .row-actions { opacity: 1; }

    #mobile-fab {
      position: fixed; right: 18px; bottom: 22px;
      width: 60px; height: 60px; border-radius: 50%;
      background: #F4A83D; color: #fff; border: none;
      font-size: 32px; line-height: 1; font-weight: 300;
      box-shadow: 0 6px 20px rgba(244,168,61,.45);
      cursor: pointer; z-index: 9000;
      align-items: center; justify-content: center;
      display: none;
    }
    #mobile-fab.on { display: flex; }
    #mobile-fab:active { transform: scale(.94); }

    #mobile-toggle {
      position: fixed; right: 18px; top: 14px;
      padding: 8px 14px; border-radius: 12px;
      background: var(--bg-elev, #fff); color: var(--text, #2B2620);
      border: 1px solid var(--border, #EAE2D3);
      font-size: 12.5px; font-weight: 600; cursor: pointer;
      box-shadow: 0 3px 10px rgba(0,0,0,.06); z-index: 9000;
      display: none;
    }
    #mobile-toggle.on { display: block; }
  `;
  document.head.appendChild(style);
}

function injectMobileUI() {
  if (!document.getElementById('mobile-fab')) {
    const fab = document.createElement('button');
    fab.id = 'mobile-fab';
    fab.type = 'button';
    fab.textContent = '+';
    fab.setAttribute('aria-label', 'Добавить операцию');
    fab.onclick = () => {
      if (typeof openTxModal === 'function') openTxModal(null);
    };
    document.body.appendChild(fab);
  }
  if (!document.getElementById('mobile-toggle')) {
    const btn = document.createElement('button');
    btn.id = 'mobile-toggle';
    btn.type = 'button';
    btn.onclick = () => setMobileMode(!isMobileMode());
    document.body.appendChild(btn);
  }
}

function applyMobileMode() {
  injectMobileCSS();
  injectMobileUI();
  const on = isMobileMode();
  const mobile = isMobileDevice();
  document.body.classList.toggle('mobile-mode', on);

  const fab = document.getElementById('mobile-fab');
  const toggle = document.getElementById('mobile-toggle');

  if (!mobile) {
    fab.classList.remove('on');
    toggle.classList.remove('on');
    return;
  }
  fab.classList.add('on');
  toggle.classList.add('on');

  if (on) {
    toggle.textContent = '⊞ Полный';
    if (typeof showView === 'function') showView('transactions');
  } else {
    toggle.textContent = '⊞ Статистика';
  }
}

/* ============================================================
   AUTH UI
   ============================================================ */
function authHtml() {
  return `
  <div id="auth-screen" style="position:fixed;inset:0;background:var(--bg,#FAF7F2);z-index:99999;display:none;align-items:center;justify-content:center;padding:20px;overflow:auto;">
    <div style="background:var(--bg-elev,#fff);border:1px solid var(--border,#EAE2D3);border-radius:22px;padding:30px 28px;width:100%;max-width:380px;box-shadow:0 6px 20px rgba(43,38,32,.08);">
      <div style="text-align:center;margin-bottom:18px;">
        <div style="font-family:'Poppins','Segoe UI',sans-serif;font-size:24px;font-weight:800;letter-spacing:.2px;color:var(--text,#2B2620);">𝐅𝐚𝐦𝐢𝐥𝐲<span style="color:#F4A83D;"> 𝐒𝐚𝐯𝐞</span></div>
      </div>
      <div style="display:flex;border:1px solid var(--border,#EAE2D3);border-radius:13px;overflow:hidden;background:var(--bg-elev-2,#F2EDE3);margin-bottom:18px;">
        <button id="auth-tab-login" style="flex:1;padding:10px 8px;border:none;background:transparent;font-size:13px;font-weight:600;color:var(--text-dim,#968F80);cursor:pointer;">Вход</button>
        <button id="auth-tab-register" style="flex:1;padding:10px 8px;border:none;background:#F4A83D;color:#fff;font-size:13px;font-weight:600;cursor:pointer;border-radius:11px;margin:2px;">Регистрация</button>
      </div>

      <div id="auth-login-form" style="display:none;">
        <div style="margin-bottom:12px;">
          <label style="display:block;font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:var(--text-dim,#968F80);margin-bottom:6px;font-weight:600;">Логин</label>
          <input type="text" id="li-login" autocomplete="username" style="width:100%;background:var(--bg-elev-2,#F2EDE3);border:1px solid var(--border,#EAE2D3);color:var(--text,#2B2620);padding:11px 14px;border-radius:12px;font-size:14px;box-sizing:border-box;">
        </div>
        <div style="margin-bottom:16px;">
          <label style="display:block;font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:var(--text-dim,#968F80);margin-bottom:6px;font-weight:600;">Пароль</label>
          <input type="password" id="li-pass" autocomplete="current-password" style="width:100%;background:var(--bg-elev-2,#F2EDE3);border:1px solid var(--border,#EAE2D3);color:var(--text,#2B2620);padding:11px 14px;border-radius:12px;font-size:14px;box-sizing:border-box;">
        </div>
        <button id="li-submit" style="width:100%;background:#F4A83D;color:#fff;border:none;padding:12px 18px;border-radius:13px;font-weight:600;font-size:13.5px;cursor:pointer;box-shadow:0 3px 10px rgba(244,168,61,.28);">Войти</button>
        <button id="li-bootstrap" style="width:100%;background:transparent;color:#F4A83D;border:1px solid #F4A83D;padding:10px 18px;border-radius:13px;font-weight:600;font-size:12.5px;cursor:pointer;margin-top:10px;">Войти с другого устройства</button>
      </div>

      <div id="auth-register-form">
        <div style="margin-bottom:12px;">
          <label style="display:block;font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:var(--text-dim,#968F80);margin-bottom:6px;font-weight:600;">Логин</label>
          <input type="text" id="rg-login" autocomplete="username" style="width:100%;background:var(--bg-elev-2,#F2EDE3);border:1px solid var(--border,#EAE2D3);color:var(--text,#2B2620);padding:11px 14px;border-radius:12px;font-size:14px;box-sizing:border-box;">
        </div>
        <div style="margin-bottom:12px;">
          <label style="display:block;font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:var(--text-dim,#968F80);margin-bottom:6px;font-weight:600;">Пароль</label>
          <input type="password" id="rg-pass" autocomplete="new-password" style="width:100%;background:var(--bg-elev-2,#F2EDE3);border:1px solid var(--border,#EAE2D3);color:var(--text,#2B2620);padding:11px 14px;border-radius:12px;font-size:14px;box-sizing:border-box;">
        </div>
        <div style="margin-bottom:16px;">
          <label style="display:block;font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:var(--text-dim,#968F80);margin-bottom:6px;font-weight:600;">Повтор пароля</label>
          <input type="password" id="rg-pass2" autocomplete="new-password" style="width:100%;background:var(--bg-elev-2,#F2EDE3);border:1px solid var(--border,#EAE2D3);color:var(--text,#2B2620);padding:11px 14px;border-radius:12px;font-size:14px;box-sizing:border-box;">
        </div>
        <button id="rg-submit" style="width:100%;background:#F4A83D;color:#fff;border:none;padding:12px 18px;border-radius:13px;font-weight:600;font-size:13.5px;cursor:pointer;box-shadow:0 3px 10px rgba(244,168,61,.28);">Создать аккаунт</button>
        <div style="font-size:11.5px;color:var(--text-dim,#968F80);text-align:center;margin-top:14px;line-height:1.5;">
          После регистрации: Настройки → GitHub Sync → настройте токен,<br>тогда аккаунт появится на других устройствах.
        </div>
      </div>

      <div id="auth-err" style="color:#F2545B;font-size:12.5px;margin-top:12px;text-align:center;min-height:16px;"></div>
    </div>

    <div id="bootstrap-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:100000;align-items:center;justify-content:center;padding:20px;">
      <div style="background:var(--bg-elev,#fff);border-radius:22px;padding:26px;width:100%;max-width:380px;box-shadow:0 6px 20px rgba(43,38,32,.15);">
        <h2 style="font-family:'Poppins','Segoe UI',sans-serif;font-size:19px;font-weight:700;margin-bottom:14px;color:var(--text,#2B2620);">Подключение с другого устройства</h2>
        <p style="font-size:12.5px;color:var(--text-dim,#968F80);line-height:1.5;margin-bottom:14px;">Введите те же настройки GitHub, что и на первом устройстве. Скачаем список аккаунтов.</p>
        <div style="margin-bottom:10px;">
          <label style="font-size:11px;text-transform:uppercase;color:var(--text-dim,#968F80);font-weight:600;">GitHub username</label>
          <input type="text" id="bs-user" style="width:100%;background:var(--bg-elev-2,#F2EDE3);border:1px solid var(--border,#EAE2D3);color:var(--text,#2B2620);padding:10px 12px;border-radius:12px;font-size:13.5px;margin-top:4px;box-sizing:border-box;">
        </div>
        <div style="margin-bottom:10px;">
          <label style="font-size:11px;text-transform:uppercase;color:var(--text-dim,#968F80);font-weight:600;">Репозиторий</label>
          <input type="text" id="bs-repo" value="budget-data" style="width:100%;background:var(--bg-elev-2,#F2EDE3);border:1px solid var(--border,#EAE2D3);color:var(--text,#2B2620);padding:10px 12px;border-radius:12px;font-size:13.5px;margin-top:4px;box-sizing:border-box;">
        </div>
        <div style="margin-bottom:10px;">
          <label style="font-size:11px;text-transform:uppercase;color:var(--text-dim,#968F80);font-weight:600;">Ветка</label>
          <input type="text" id="bs-branch" value="main" style="width:100%;background:var(--bg-elev-2,#F2EDE3);border:1px solid var(--border,#EAE2D3);color:var(--text,#2B2620);padding:10px 12px;border-radius:12px;font-size:13.5px;margin-top:4px;box-sizing:border-box;">
        </div>
        <div style="margin-bottom:16px;">
          <label style="font-size:11px;text-transform:uppercase;color:var(--text-dim,#968F80);font-weight:600;">Token</label>
          <input type="password" id="bs-token" placeholder="github_pat_..." style="width:100%;background:var(--bg-elev-2,#F2EDE3);border:1px solid var(--border,#EAE2D3);color:var(--text,#2B2620);padding:10px 12px;border-radius:12px;font-size:13.5px;margin-top:4px;box-sizing:border-box;">
        </div>
        <div id="bs-err" style="color:#F2545B;font-size:12.5px;margin-bottom:10px;min-height:14px;"></div>
        <div style="display:flex;gap:8px;justify-content:flex-end;">
          <button id="bs-cancel" style="background:var(--bg-elev-2,#F2EDE3);color:var(--text,#2B2620);border:1px solid var(--border,#EAE2D3);padding:9px 16px;border-radius:11px;font-weight:600;font-size:13px;cursor:pointer;">Отмена</button>
          <button id="bs-go" style="background:#F4A83D;color:#fff;border:none;padding:9px 16px;border-radius:11px;font-weight:600;font-size:13px;cursor:pointer;">Подключить</button>
        </div>
      </div>
    </div>
  </div>`;
}

function injectAuth() {
  if (document.getElementById('auth-screen')) return;
  const wrap = document.createElement('div');
  wrap.innerHTML = authHtml();
  document.body.appendChild(wrap.firstElementChild);
  wireAuth();
}
function showAuth() {
  injectAuth();
  const el = document.getElementById('auth-screen');
  if (el) el.style.display = 'flex';
}
function hideAuth() {
  const el = document.getElementById('auth-screen');
  if (el) el.style.display = 'none';
}

function setAuthTab(tab) {
  const loginTab = document.getElementById('auth-tab-login');
  const regTab = document.getElementById('auth-tab-register');
  const loginForm = document.getElementById('auth-login-form');
  const regForm = document.getElementById('auth-register-form');
  const err = document.getElementById('auth-err');
  err.textContent = '';
  const on = 'background:#F4A83D;color:#fff;border-radius:11px;margin:2px;';
  const off = 'background:transparent;color:var(--text-dim,#968F80);margin:0;';
  if (tab === 'login') {
    loginTab.style.cssText += ';' + on; regTab.style.cssText += ';' + off;
    loginForm.style.display = 'block'; regForm.style.display = 'none';
    setTimeout(() => document.getElementById('li-login').focus(), 50);
  } else {
    regTab.style.cssText += ';' + on; loginTab.style.cssText += ';' + off;
    regForm.style.display = 'block'; loginForm.style.display = 'none';
    setTimeout(() => document.getElementById('rg-login').focus(), 50);
  }
}

function wireAuth() {
  document.getElementById('auth-tab-login').onclick = () => setAuthTab('login');
  document.getElementById('auth-tab-register').onclick = () => setAuthTab('register');

  const doLogin = async () => {
    const login = (document.getElementById('li-login').value || '').trim().toLowerCase();
    const pass  = document.getElementById('li-pass').value || '';
    const err = document.getElementById('auth-err');
    err.textContent = '';
    if (!login || !pass) { err.textContent = 'Заполните логин и пароль'; return; }
    const accs = accounts();
    if (!accs[login]) {
      err.textContent = 'Аккаунт не найден. Нажмите «Войти с другого устройства».';
      return;
    }
    const h = await sha256(login + ':' + pass);
    if (h !== accs[login].hash) { err.textContent = 'Неверный пароль'; return; }
    enterAccount(login);
  };

  const doRegister = async () => {
    const login = (document.getElementById('rg-login').value || '').trim().toLowerCase();
    const p1 = document.getElementById('rg-pass').value || '';
    const p2 = document.getElementById('rg-pass2').value || '';
    const err = document.getElementById('auth-err');
    err.textContent = '';
    if (!login || login.length < 3) { err.textContent = 'Логин минимум 3 символа'; return; }
    if (!/^[a-z0-9_\-]+$/.test(login)) { err.textContent = 'Логин: латиница, цифры, _, -'; return; }
    if (p1.length < 4) { err.textContent = 'Пароль минимум 4 символа'; return; }
    if (p1 !== p2) { err.textContent = 'Пароли не совпадают'; return; }
    const accs = accounts();
    if (accs[login]) { err.textContent = 'Такой логин уже занят'; return; }
    const h = await sha256(login + ':' + p1);
    accs[login] = { hash: h, createdAt: new Date().toISOString() };
    saveAccounts(accs);
    enterAccount(login, true);
  };

  document.getElementById('li-submit').onclick = doLogin;
  document.getElementById('rg-submit').onclick = doRegister;
  document.getElementById('li-pass').onkeydown = e => { if (e.key === 'Enter') doLogin(); };
  document.getElementById('rg-pass2').onkeydown = e => { if (e.key === 'Enter') doRegister(); };

  document.getElementById('li-bootstrap').onclick = () => {
    document.getElementById('bootstrap-modal').style.display = 'flex';
    document.getElementById('bs-err').textContent = '';
    setTimeout(() => document.getElementById('bs-user').focus(), 50);
  };
  document.getElementById('bs-cancel').onclick = () => {
    document.getElementById('bootstrap-modal').style.display = 'none';
  };
  document.getElementById('bs-go').onclick = async () => {
    const user = document.getElementById('bs-user').value.trim();
    const repo = document.getElementById('bs-repo').value.trim() || 'budget-data';
    const branch = document.getElementById('bs-branch').value.trim() || 'main';
    const token = document.getElementById('bs-token').value.trim();
    const err = document.getElementById('bs-err');
    err.style.color = '#F2545B';
    err.textContent = '';
    if (!user || !repo || !token) { err.textContent = 'Заполните все поля'; return; }
    err.textContent = 'Подключение...';
    const remote = await pullAccountsFile(user, repo, token, branch);
    if (!remote || Object.keys(remote).length === 0) {
      err.textContent = 'Не удалось загрузить accounts.json. Проверьте токен/репо.';
      return;
    }
    const local = accounts();
    const merged = Object.assign({}, remote, local);
    localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(merged));
    setPendingGh({ user, repo, token, branch });
    err.style.color = '#2FBF71';
    err.textContent = 'Готово! Войдите под своим логином.';
    setTimeout(() => {
      document.getElementById('bootstrap-modal').style.display = 'none';
      document.getElementById('li-login').value = Object.keys(remote)[0] || '';
      document.getElementById('li-pass').focus();
    }, 800);
  };

  setAuthTab('login');
}

function enterAccount(login, isNew) {
  currentUser = login;
  saveSession({ login, createdAt: new Date().toISOString() });
  const pending = pendingGh();
  if (pending) {
    ghSaveCfg(pending, login);
    setPendingGh(null);
  }
  const udata = loadUserData(login);
  if (udata) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(udata));
  } else {
    try {
      const fresh = defaultState();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(fresh));
      saveUserData(login, fresh);
    } catch (e) {}
  }
  setLoadedUser(login);
  location.reload();
}

function logout() {
  if (!confirm('Выйти из аккаунта? Данные останутся, пароль спросят при входе.')) return;
  saveSession(null);
  setLoadedUser(null);
  try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
  location.reload();
}

/* ---------- GitHub settings card ---------- */
function injectGithubCard() {
  if (document.getElementById('gh-sync-card')) return;
  const settings = document.getElementById('view-settings');
  if (!settings) return;
  const col = settings.querySelector('.grid.two-col');
  if (!col) return;

  const cfg = ghCfg();
  const card = document.createElement('div');
  card.className = 'card';
  card.id = 'gh-sync-card';
  card.style.gridColumn = '1 / -1';
  card.style.marginTop = '16px';
  card.innerHTML = `
    <div class="stat-label" style="margin-bottom:12px;">Синхронизация с GitHub</div>
    <p style="font-size:12.5px;color:var(--text-dim);line-height:1.6;margin-bottom:14px;">
      Аккаунт: <strong>${currentUser || '—'}</strong>. Данные и список аккаунтов синхронизируются
      с приватным репозиторием. Токен хранится только в этом браузере.
    </p>
    <div class="field-row">
      <div class="field"><label>GitHub username</label>
        <input type="text" id="gh-user" value="${cfg.user || ''}" placeholder="ваш-логин"></div>
      <div class="field"><label>Репозиторий (приватный)</label>
        <input type="text" id="gh-repo" value="${cfg.repo || 'budget-data'}" placeholder="budget-data"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Ветка</label>
        <input type="text" id="gh-branch" value="${cfg.branch || 'main'}" placeholder="main"></div>
      <div class="field"><label>Файл данных</label>
        <input type="text" id="gh-path" value="${cfg.path || 'data.json'}" placeholder="data.json"></div>
    </div>
    <div class="field"><label>Personal Access Token</label>
      <input type="password" id="gh-token" value="${cfg.token || ''}" placeholder="github_pat_...">
      <div class="hint">Создать: github.com/settings/tokens?type=beta. Права: Contents → Read and write, только на репозиторий с данными.</div>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;">
      <button class="btn small" id="gh-save">Сохранить</button>
      <button class="btn secondary small" id="gh-push">Отправить</button>
      <button class="btn secondary small" id="gh-pull">Загрузить</button>
      <button class="btn danger small" id="gh-logout" style="margin-left:auto;">Выйти из аккаунта</button>
    </div>
    <div class="hint" id="gh-status" style="margin-top:10px;"></div>
  `;
  col.appendChild(card);

  document.getElementById('gh-save').onclick = async () => {
    const c = ghCfg();
    c.user = document.getElementById('gh-user').value.trim();
    c.repo = document.getElementById('gh-repo').value.trim();
    c.branch = document.getElementById('gh-branch').value.trim() || 'main';
    c.path = document.getElementById('gh-path').value.trim() || 'data.json';
    c.token = document.getElementById('gh-token').value.trim();
    ghSaveCfg(c);
    ghSha = null;
    if (typeof toast === 'function') toast('Настройки сохранены', 'ok');
    await pushAccountsFile();
    await ghPullAndMerge();
    ghUpdateStatus();
  };
  document.getElementById('gh-push').onclick = async () => {
    await pushAccountsFile();
    ghPushNow('manual');
  };
  document.getElementById('gh-pull').onclick = async () => {
    await ghPullAndMerge();
    if (typeof toast === 'function') toast('Загружено', 'ok');
    ghUpdateStatus();
  };
  document.getElementById('gh-logout').onclick = logout;
  ghUpdateStatus();
}

function ghUpdateStatus() {
  const el = document.getElementById('gh-status');
  if (!el) return;
  const c = ghCfg();
  if (!c.token || !c.user || !c.repo) {
    el.textContent = 'Не настроено. Заполните поля и нажмите Сохранить.';
  } else {
    el.textContent = 'Последняя синхронизация: ' + (c.lastSync || '—');
  }
}

/* ---------- boot ---------- */
function boot() {
  if (booted) return;
  booted = true;
  injectAuth();

  const s = session();
  if (!s || !s.login) { showAuth(); return; }
  const accs = accounts();
  if (!accs[s.login]) { saveSession(null); showAuth(); return; }
  currentUser = s.login;

  if (loadedUser() !== s.login) {
    const udata = loadUserData(s.login);
    if (udata) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(udata));
    } else {
      try { saveUserData(s.login, state); } catch (e) {}
    }
    setLoadedUser(s.login);
    location.reload();
    return;
  }

  hideAuth();
  hookPersist();

  // подменяем рендер счетов на версию с нативной валютой
  try { window.renderAccounts = renderAccountsNative; } catch (e) {}
  if (typeof renderAll === 'function') {
    try { renderAll(); } catch (e) {}
  }

  // мобильный режим
  setTimeout(() => { applyMobileMode(); }, 250);

  setTimeout(injectGithubCard, 400);
  setInterval(() => {
    if (!document.getElementById('gh-sync-card')) injectGithubCard();
  }, 1500);

  const c = ghCfg();
  if (c.token && c.user && c.repo) {
    setTimeout(ghPullAndMerge, 900);
    setInterval(() => {
      if (document.visibilityState === 'visible') ghPullAndMerge();
    }, 120000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') ghPullAndMerge();
    });
  }

  // ресайз — пересчёт мобильного режима
  let rzTimer = null;
  window.addEventListener('resize', () => {
    if (rzTimer) clearTimeout(rzTimer);
    rzTimer = setTimeout(applyMobileMode, 200);
  });
  window.addEventListener('orientationchange', applyMobileMode);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

window.ghSync = {
  pull: ghPullAndMerge,
  push: () => ghPushNow('manual'),
  pushAccounts: pushAccountsFile,
  status: ghUpdateStatus,
  cfg: ghCfg,
  logout: logout,
  whoami: () => currentUser,
  mobile: { on: () => setMobileMode(true), off: () => setMobileMode(false), state: isMobileMode }
};

})();
