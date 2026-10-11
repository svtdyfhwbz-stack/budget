/* =============================================================
   sync.js — Multi-account + Persistent session + GitHub Sync
   Требует index.html загруженным раньше: state, persist, renderAll,
   toast, defaultState, STORAGE_KEY — доступны как глобальные let/const.
   ============================================================= */
(function () {
'use strict';

const ACCOUNTS_KEY     = 'budget_accounts_v2';
const SESSION_KEY      = 'budget_session_v2';
const LOADED_USER_KEY  = 'budget_loaded_user_v2';
const DATA_PREFIX      = 'budget_data_';
const GH_PREFIX        = 'budget_gh_';
const GH_API           = 'https://api.github.com';

let currentUser = null;
let ghSha = null;
let ghPushTimer = null;
let ghSyncing = false;
let booted = false;

/* ---------- storage helpers ---------- */
function accounts() {
  try { return JSON.parse(localStorage.getItem(ACCOUNTS_KEY) || '{}'); }
  catch { return {}; }
}
function saveAccounts(a) { localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(a)); }

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

/* ---------- GitHub API ---------- */
async function ghFetch(method, url, body) {
  const cfg = ghCfg();
  if (!cfg.token) throw new Error('Токен не задан');
  const headers = {
    'Authorization': 'Bearer ' + cfg.token,
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
    throw new Error('GitHub ' + r.status + ': ' + txt.slice(0, 200));
  }
  return r.json();
}

async function ghPull() {
  const cfg = ghCfg();
  if (!cfg.token || !cfg.user || !cfg.repo) return null;
  const path = cfg.path || 'data.json';
  const branch = cfg.branch || 'main';
  const j = await ghFetch('GET', `/repos/${cfg.user}/${cfg.repo}/contents/${path}?ref=${branch}`);
  if (!j) return null;
  try { return { data: JSON.parse(b64ToUtf8(j.content)), sha: j.sha }; }
  catch (e) { console.warn('ghPull parse error', e); return null; }
}

async function ghPush(message) {
  const cfg = ghCfg();
  if (!cfg.token || !cfg.user || !cfg.repo) return false;
  const path = cfg.path || 'data.json';
  const branch = cfg.branch || 'main';
  if (ghSha === null) {
    const existing = await ghFetch('GET', `/repos/${cfg.user}/${cfg.repo}/contents/${path}?ref=${branch}`);
    ghSha = existing ? existing.sha : null;
  }
  state.lastModified = new Date().toISOString();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  saveUserData(currentUser, state);
  const content = utf8ToB64(JSON.stringify(state, null, 2));
  const body = { message: message || ('sync ' + new Date().toISOString()), content, branch };
  if (ghSha) body.sha = ghSha;
  const r = await ghFetch('PUT', `/repos/${cfg.user}/${cfg.repo}/contents/${path}`, body);
  if (r && r.content) {
    ghSha = r.content.sha;
    cfg.lastSync = new Date().toLocaleString('ru-RU');
    ghSaveCfg(cfg);
    return true;
  }
  return false;
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
  }, 2500);
}

/* ---------- persist hook ---------- */
function hookPersist() {
  if (typeof persist !== 'function') { setTimeout(hookPersist, 200); return; }
  if (persist.__ghHooked) return;
  const orig = persist;
  window.persist = async function (options) {
    const r = await orig.call(this, options || {});
    // mirror to current user's dedicated slot
    if (currentUser) {
      try { saveUserData(currentUser, state); } catch (e) {}
    }
    if (!options || !options.skipSync) ghSchedulePush();
    return r;
  };
  window.persist.__ghHooked = true;
}

/* ---------- UI: auth screen ---------- */
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
      </div>

      <div id="auth-err" style="color:#F2545B;font-size:12.5px;margin-top:12px;text-align:center;min-height:16px;"></div>
      <div style="color:var(--text-dim,#968F80);font-size:11.5px;text-align:center;margin-top:14px;line-height:1.5;">
        Сессия хранится в этом браузере. Пароль не спросит, пока не нажмёшь «Выйти».
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
    if (!accs[login]) { err.textContent = 'Аккаунт не найден'; return; }
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
    enterAccount(login);
  };

  document.getElementById('li-submit').onclick = doLogin;
  document.getElementById('rg-submit').onclick = doRegister;
  document.getElementById('li-pass').onkeydown = e => { if (e.key === 'Enter') doLogin(); };
  document.getElementById('rg-pass2').onkeydown = e => { if (e.key === 'Enter') doRegister(); };
  setAuthTab('login');
}

function enterAccount(login) {
  currentUser = login;
  saveSession({ login, createdAt: new Date().toISOString() });
  // if data for this user exists, swap into STORAGE_KEY and reload so index.html re-reads it
  const udata = loadUserData(login);
  if (udata) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(udata));
  } else {
    // fresh account — start with default state
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
  if (!confirm('Выйти из аккаунта? Данные останутся, пароль спросит снова при входе.')) return;
  saveSession(null);
  setLoadedUser(null);
  // clear shared STORAGE_KEY so next visitor doesn't see old data
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
      Данные этого аккаунта (<strong>${currentUser || '—'}</strong>) синхронизируются с приватным
      репозиторием GitHub. Токен хранится только в этом браузере.
    </p>
    <div class="field-row">
      <div class="field"><label>GitHub username</label>
        <input type="text" id="gh-user" value="${cfg.user || ''}" placeholder="ваш-логин"></div>
      <div class="field"><label>Репозиторий (приватный)</label>
        <input type="text" id="gh-repo" value="${cfg.repo || 'budget-data'}" placeholder="budget-data"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Файл</label>
        <input type="text" id="gh-path" value="${cfg.path || 'data.json'}" placeholder="data.json"></div>
      <div class="field"><label>Ветка</label>
        <input type="text" id="gh-branch" value="${cfg.branch || 'main'}" placeholder="main"></div>
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

  document.getElementById('gh-save').onclick = () => {
    const c = ghCfg();
    c.user = document.getElementById('gh-user').value.trim();
    c.repo = document.getElementById('gh-repo').value.trim();
    c.path = document.getElementById('gh-path').value.trim() || 'data.json';
    c.branch = document.getElementById('gh-branch').value.trim() || 'main';
    c.token = document.getElementById('gh-token').value.trim();
    ghSaveCfg(c);
    ghSha = null;
    if (typeof toast === 'function') toast('Настройки синхронизации сохранены', 'ok');
    ghPullAndMerge();
    ghUpdateStatus();
  };
  document.getElementById('gh-push').onclick = () => ghPushNow('manual');
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
  if (!s || !s.login) {
    // no session → show login/register screen
    showAuth();
    return;
  }
  const accs = accounts();
  if (!accs[s.login]) {
    // account was deleted → force re-register
    saveSession(null);
    showAuth();
    return;
  }
  currentUser = s.login;

  // one-time swap: ensure STORAGE_KEY holds this user's data
  if (loadedUser() !== s.login) {
    const udata = loadUserData(s.login);
    if (udata) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(udata));
    } else {
      // account exists but no data → use current STORAGE_KEY as their seed
      try { saveUserData(s.login, state); } catch (e) {}
    }
    setLoadedUser(s.login);
    location.reload();
    return;
  }

  // everything ready: hide auth, hook persist, inject GitHub card
  hideAuth();
  hookPersist();
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
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

// debug helpers
window.ghSync = {
  pull: ghPullAndMerge,
  push: () => ghPushNow('manual'),
  status: ghUpdateStatus,
  cfg: ghCfg,
  logout: logout,
  whoami: () => currentUser
};

})();
