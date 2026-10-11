/* =============================================================
   sync.js — GitHub Sync + Lock Screen для "Family Save"
   Требует: index.html должен быть загружен раньше (глобалы state,
   persist, renderAll, toast, defaultState, STORAGE_KEY).
   ============================================================= */
(function () {
'use strict';

const GH_CFG_KEY = 'budget_gh_cfg_v1';
const GH_LOCK_KEY = 'budget_lock_v1';
const GH_API = 'https://api.github.com';

let ghSha = null;
let ghPushTimer = null;
let ghSyncing = false;
let ghBooted = false;

/* ---------- config ---------- */
function ghCfg() {
  try { return JSON.parse(localStorage.getItem(GH_CFG_KEY) || '{}'); }
  catch { return {}; }
}
function ghSaveCfg(c) { localStorage.setItem(GH_CFG_KEY, JSON.stringify(c)); }

/* ---------- base64 / sha ---------- */
async function ghSha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
function ghUtf8ToB64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function ghB64ToUtf8(b64) {
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
  try {
    return { data: JSON.parse(ghB64ToUtf8(j.content)), sha: j.sha };
  } catch (e) {
    console.warn('ghPull parse error:', e);
    return null;
  }
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
  const content = ghUtf8ToB64(JSON.stringify(state, null, 2));
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

/* ---------- sync flow ---------- */
async function ghPullAndMerge() {
  if (ghSyncing) return;
  ghSyncing = true;
  try {
    const remote = await ghPull();
    if (!remote) return;
    ghSha = remote.sha;
    const rt = new Date(remote.data && remote.data.lastModified || 0).getTime();
    const lt = new Date(state && state.lastModified || 0).getTime();
    if (rt > lt) {
      state = Object.assign(defaultState(), remote.data);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
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

/* ---------- monkey-patch persist ---------- */
function ghHookPersist() {
  if (typeof window.persist !== 'function') {
    console.warn('sync.js: persist not found, retrying...');
    setTimeout(ghHookPersist, 300);
    return;
  }
  if (window.persist.__ghHooked) return;
  const orig = window.persist;
  window.persist = async function (options) {
    const r = await orig.call(this, options || {});
    if (!options || !options.skipSync) ghSchedulePush();
    return r;
  };
  window.persist.__ghHooked = true;
  console.log('sync.js: persist hooked');
}

/* ---------- lock screen ---------- */
function ghInjectLockHtml() {
  if (document.getElementById('lock-screen')) return;
  const div = document.createElement('div');
  div.id = 'lock-screen';
  div.style.cssText = 'position:fixed;inset:0;background:var(--bg,#FAF7F2);z-index:99999;display:none;align-items:center;justify-content:center;padding:20px;';
  div.innerHTML = `
    <div style="background:var(--bg-elev,#fff);border:1px solid var(--border,#EAE2D3);border-radius:22px;padding:32px 28px;width:100%;max-width:360px;box-shadow:0 6px 20px rgba(43,38,32,.08);text-align:center;">
      <div style="font-family:'Poppins','Segoe UI',sans-serif;font-size:24px;font-weight:800;margin-bottom:6px;letter-spacing:.2px;color:var(--text,#2B2620);">𝐅𝐚𝐦𝐢𝐥𝐲<span style="color:#F4A83D;"> 𝐒𝐚𝐯𝐞</span></div>
      <div id="lock-sub" style="color:var(--text-dim,#968F80);font-size:13px;margin-bottom:18px;">Введите пароль</div>
      <input type="password" id="lock-input" autocomplete="current-password" placeholder="Пароль" style="width:100%;background:var(--bg-elev-2,#F2EDE3);border:1px solid var(--border,#EAE2D3);color:var(--text,#2B2620);padding:11px 14px;border-radius:12px;font-size:14px;box-sizing:border-box;">
      <button id="lock-btn" style="width:100%;margin-top:12px;background:#F4A83D;color:#fff;border:none;padding:11px 18px;border-radius:13px;font-weight:600;font-size:13.5px;cursor:pointer;box-shadow:0 3px 10px rgba(244,168,61,.28);">Войти</button>
      <div id="lock-err" style="color:#F2545B;font-size:12.5px;margin-top:10px;min-height:16px;"></div>
    </div>`;
  document.body.appendChild(div);
}

function ghShowLock() {
  ghInjectLockHtml();
  const el = document.getElementById('lock-screen');
  if (!el) return;
  el.style.display = 'flex';
  const cfg = ghCfg();
  document.getElementById('lock-sub').textContent =
    cfg.passwordHash ? 'Введите пароль' : 'Первый запуск — задайте пароль';
  const inp = document.getElementById('lock-input');
  const err = document.getElementById('lock-err');
  const btn = document.getElementById('lock-btn');
  inp.value = ''; err.textContent = '';

  const submit = async () => {
    const p = inp.value.trim();
    if (!p) { err.textContent = 'Введите пароль'; return; }
    btn.disabled = true;
    try {
      const h = await ghSha256(p);
      const c = ghCfg();
      if (!c.passwordHash) {
        c.passwordHash = h;
        ghSaveCfg(c);
        sessionStorage.setItem(GH_LOCK_KEY, '1');
        ghHideLock();
        ghAfterUnlock(true);
        return;
      }
      if (h === c.passwordHash) {
        sessionStorage.setItem(GH_LOCK_KEY, '1');
        ghHideLock();
        ghAfterUnlock(false);
      } else {
        err.textContent = 'Неверный пароль';
        inp.value = '';
      }
    } finally {
      btn.disabled = false;
    }
  };
  btn.onclick = submit;
  inp.onkeydown = e => { if (e.key === 'Enter') submit(); };
  setTimeout(() => inp.focus(), 50);
}

function ghHideLock() {
  const el = document.getElementById('lock-screen');
  if (el) el.style.display = 'none';
}

/* ---------- settings card ---------- */
function ghInjectSettings() {
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
      Данные хранятся в приватном репозитории GitHub. Доступ — по Personal Access Token,
      который остаётся только в этом браузере (в HTML он не попадает).
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
      <button class="btn ghost small" id="gh-reset-pass" style="margin-left:auto;">Сменить пароль</button>
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
  document.getElementById('gh-reset-pass').onclick = () => {
    if (!confirm('Сменить пароль? Текущий будет сброшен, зададите новый при следующем входе.')) return;
    const c = ghCfg();
    delete c.passwordHash;
    ghSaveCfg(c);
    if (typeof toast === 'function') toast('Пароль сброшен — перезайдите', 'ok');
    setTimeout(() => location.reload(), 800);
  };
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

/* ---------- unlock flow ---------- */
function ghAfterUnlock(firstLaunch) {
  ghHookPersist();
  setTimeout(ghInjectSettings, 300);
  setInterval(() => {
    if (!document.getElementById('gh-sync-card')) ghInjectSettings();
  }, 1500);

  const c = ghCfg();
  if (c.token && c.user && c.repo) {
    setTimeout(ghPullAndMerge, 800);
  }
  if (firstLaunch && typeof toast === 'function') {
    setTimeout(() => toast('Пароль установлен. Настройки → Синхронизация с GitHub.', 'ok'), 1200);
  }
  setInterval(() => {
    if (document.visibilityState === 'visible' && ghCfg().token) ghPullAndMerge();
  }, 120000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && ghCfg().token) ghPullAndMerge();
  });
}

/* ---------- boot ---------- */
function ghBoot() {
  if (ghBooted) return;
  ghBooted = true;
  ghInjectLockHtml();
  if (sessionStorage.getItem(GH_LOCK_KEY) === '1') {
    ghHideLock();
    ghAfterUnlock(false);
  } else {
    ghShowLock();
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', ghBoot);
} else {
  ghBoot();
}

// expose for debugging in console
window.ghSync = {
  pull: ghPullAndMerge,
  push: () => ghPushNow('manual'),
  status: ghUpdateStatus,
  cfg: ghCfg
};

})();
