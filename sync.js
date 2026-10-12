/* =============================================================
   sync.js — v12 (live crypto search + deposits with interest)
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
const GOAL_CAT_NAME   = 'Цели';
const PORTFOLIO_CAT_NAME = 'Портфель';
const FX_CACHE_KEY    = 'budget_fx_rates_v1';
const CRYPTO_CACHE_KEY = 'budget_crypto_top_v1';
const FX_REFRESH_MS   = 15 * 60 * 1000;
const FX_STALE_MS     = 60 * 60 * 1000;
const CRYPTO_CACHE_MS = 60 * 60 * 1000;

const FX_FALLBACK = {
  'USD_EUR': 0.92, 'EUR_USD': 1.087, 'USD_RUB': 92.0, 'RUB_USD': 0.0109,
  'EUR_RUB': 100.0, 'RUB_EUR': 0.010, 'USD_GBP': 0.79, 'GBP_USD': 1.27,
  'USD_KZT': 480.0, 'KZT_USD': 0.0021, 'USD_UAH': 41.5, 'UAH_USD': 0.024,
  'USD_BYN': 3.27, 'BYN_USD': 0.31, 'USD_TRY': 34.5, 'TRY_USD': 0.029,
  'USD_CNY': 7.25, 'CNY_USD': 0.138, 'USD_JPY': 155.0, 'JPY_USD': 0.00645,
  'USD_CHF': 0.88, 'CHF_USD': 1.136, 'USD_AED': 3.67, 'AED_USD': 0.272
};

let currentUser = null;
let ghSha = null;
let ghPushTimer = null;
let ghAccountsTimer = null;
let ghSyncing = false;
let booted = false;
let pushInFlight = false;
let fxTimer = null;

/* ---------- storage ---------- */
function accounts() { try { return JSON.parse(localStorage.getItem(ACCOUNTS_KEY) || '{}'); } catch { return {}; } }
function saveAccounts(a) { localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(a)); schedulePushAccounts(); }
function session() { try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; } }
function saveSession(s) { if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s)); else localStorage.removeItem(SESSION_KEY); }
function loadedUser() { return localStorage.getItem(LOADED_USER_KEY) || null; }
function setLoadedUser(u) { if (u) localStorage.setItem(LOADED_USER_KEY, u); else localStorage.removeItem(LOADED_USER_KEY); }
function pendingGh() { try { return JSON.parse(localStorage.getItem(PENDING_GH_KEY) || 'null'); } catch { return null; } }
function setPendingGh(v) { if (v) localStorage.setItem(PENDING_GH_KEY, JSON.stringify(v)); else localStorage.removeItem(PENDING_GH_KEY); }
function dataKey(u) { return DATA_PREFIX + u; }
function ghKey(u) { return GH_PREFIX + u; }
function loadUserData(u) { try { return JSON.parse(localStorage.getItem(dataKey(u)) || 'null'); } catch { return null; } }
function saveUserData(u, data) { try { localStorage.setItem(dataKey(u), JSON.stringify(data)); } catch (e) {} }
function ghCfg(u) { u = u || currentUser; if (!u) return {}; try { return JSON.parse(localStorage.getItem(ghKey(u)) || '{}'); } catch { return {}; } }
function ghSaveCfg(cfg, u) { u = u || currentUser; if (!u) return; localStorage.setItem(ghKey(u), JSON.stringify(cfg)); }

/* ---------- crypto helpers ---------- */
async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
function utf8ToB64(str) {
  const bytes = new TextEncoder().encode(str); let bin = '';
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
  const headers = { 'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github.v3+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (body) headers['Content-Type'] = 'application/json';
  const r = await fetch(GH_API + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 404) return null;
  if (!r.ok) { const txt = await r.text().catch(() => ''); throw new Error('GitHub ' + r.status + ': ' + txt.slice(0, 300)); }
  return r.json();
}
async function ghFetch(method, url, body) {
  const cfg = ghCfg();
  if (!cfg.token) throw new Error('Токен не задан');
  return ghFetchRaw(method, url, body, cfg.token);
}
function parseCurrentSha(msg) { const m = String(msg || '').match(/is at ([0-9a-f]{40})/i); return m ? m[1] : null; }
async function ghGetFile(path, cfg, rawToken) {
  const branch = cfg.branch || 'main';
  const url = `/repos/${cfg.user}/${cfg.repo}/contents/${path}?ref=${branch}&cb=${Date.now()}-${Math.random()}`;
  try { if (rawToken) return await ghFetchRaw('GET', url, null, rawToken); return await ghFetch('GET', url); } catch (e) { return null; }
}
async function ghAtomicPut(path, contentB64, message, cfg) {
  const branch = cfg.branch || 'main';
  const url = `/repos/${cfg.user}/${cfg.repo}/contents/${path}`;
  let shaHint = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    let sha = shaHint; shaHint = null;
    if (!sha) { const j = await ghGetFile(path, cfg); if (j && j.sha) sha = j.sha; }
    const body = { message, content: contentB64, branch };
    if (sha) body.sha = sha;
    try {
      const r = await ghFetch('PUT', url, body);
      if (r && r.content) return { ok: true, sha: r.content.sha };
    } catch (e) {
      const msg = String((e && e.message) || '');
      const isConflict = msg.includes('409') || msg.includes('422') || msg.includes('does not match') || msg.includes("sha wasn't supplied");
      if (isConflict) { shaHint = parseCurrentSha(msg); await new Promise(r => setTimeout(r, 400 * Math.pow(1.6, attempt) + Math.random() * 900)); continue; }
      throw e;
    }
  }
  return { ok: false };
}

/* ---------- sync ---------- */
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
  } catch (e) { return null; }
}
async function ghPull() {
  const cfg = ghCfg();
  if (!cfg.token || !cfg.user || !cfg.repo) return null;
  const path = cfg.path || 'data.json';
  const j = await ghGetFile(path, cfg);
  if (!j) return null;
  try { return { data: JSON.parse(b64ToUtf8(j.content)), sha: j.sha }; } catch (e) { return null; }
}
async function ghPush(message) {
  if (pushInFlight) return false;
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
        const sd = JSON.parse(b64ToUtf8(remote.content));
        const rt = new Date(sd.lastModified || 0).getTime();
        const lt = new Date(state.lastModified || 0).getTime();
        if (rt > lt + 3000) {
          state = Object.assign(defaultState(), sd);
          localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
          saveUserData(currentUser, state);
          if (typeof renderAll === 'function') renderAll();
          if (typeof toast === 'function') toast('Данные с сервера свежее — загружены', 'ok');
          return false;
        }
      } catch (e) {}
    }
    const content = utf8ToB64(JSON.stringify(state, null, 2));
    const res = await ghAtomicPut(path, content, message || ('sync ' + new Date().toISOString()), cfg);
    if (res.ok) { ghSha = res.sha; cfg.lastSync = new Date().toLocaleString('ru-RU'); ghSaveCfg(cfg); return true; }
    return false;
  } finally { pushInFlight = false; }
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
  } catch (e) {} finally { ghSyncing = false; }
}
async function ghPushNow(message) {
  try {
    const ok = await ghPush(message);
    if (ok && typeof toast === 'function') toast('Отправлено на GitHub', 'ok');
    ghUpdateStatus();
  } catch (e) { if (typeof toast === 'function') toast('Ошибка синхронизации: ' + e.message, 'err'); }
}
function ghSchedulePush() {
  if (ghPushTimer) clearTimeout(ghPushTimer);
  ghPushTimer = setTimeout(() => { if (ghCfg().token) ghPushNow('auto'); }, 2500 + Math.random() * 1500);
}
function triggerImmediatePush(reason) {
  if (!currentUser) return;
  const cfg = ghCfg();
  if (!cfg.token || !cfg.user || !cfg.repo) return;
  if (ghPushTimer) { clearTimeout(ghPushTimer); ghPushTimer = null; }
  ghPushNow(reason || 'immediate');
}

/* ============================================================
   FX
   ============================================================ */
function loadFxCache() { try { return JSON.parse(localStorage.getItem(FX_CACHE_KEY) || '{}'); } catch { return {}; } }
function saveFxCache(c) { try { localStorage.setItem(FX_CACHE_KEY, JSON.stringify(c)); } catch (e) {} }

async function fetchFxRate(from, to) {
  if (!from || !to || from === to) return 1;
  const providers = [
    async () => { const r = await fetch(`https://open.er-api.com/v6/latest/${from}`, { cache: 'no-store' }); const j = await r.json(); return j && j.rates && j.rates[to]; },
    async () => { const r = await fetch(`https://api.frankfurter.app/latest?from=${from}&to=${to}`, { cache: 'no-store' }); const j = await r.json(); return j && j.rates && j.rates[to]; },
    async () => { const r = await fetch(`https://api.exchangerate-api.com/v4/latest/${from}`, { cache: 'no-store' }); const j = await r.json(); return j && j.rates && j.rates[to]; },
    async () => { const f = from.toLowerCase(), t = to.toLowerCase(); const r = await fetch(`https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/${f}.json`, { cache: 'no-store' }); const j = await r.json(); return j && j[f] && j[f][t]; }
  ];
  for (const p of providers) { try { const rate = await p(); if (rate && rate > 0) return rate; } catch (e) {} }
  return null;
}
async function refreshAllFxRates(showToast) {
  const cache = loadFxCache();
  const base = (state && state.settings && state.settings.baseCurrency) || 'RUB';
  const currencies = new Set([base]);
  (state.accounts || []).forEach(a => {
    if (a.currency) currencies.add(a.currency);
    if (a.type === 'crypto' && a.crypto && a.crypto.currency) currencies.add(a.crypto.currency);
  });
  const others = [...currencies].filter(c => c !== base);
  let updated = 0, total = 0;
  for (const cur of others) {
    total++;
    const rate = await fetchFxRate(cur, base);
    if (rate) { cache[cur + '_' + base] = { rate, ts: Date.now() }; cache[base + '_' + cur] = { rate: 1 / rate, ts: Date.now() }; updated++; }
    else { const k = cur + '_' + base; if (!cache[k] || !cache[k].rate) { if (FX_FALLBACK[k]) cache[k] = { rate: FX_FALLBACK[k], ts: 0, fallback: true }; } }
  }
  saveFxCache(cache);
  if (showToast && typeof toast === 'function') {
    if (updated > 0) toast('Курсы обновлены (' + updated + ')', 'ok');
    else if (total > 0) toast('Курсы не удалось получить — используется кэш', 'err');
  }
  return { updated, total };
}
function cachedFxRateLive(from, to) {
  if (!from || !to || from === to) return 1;
  const cache = loadFxCache();
  const entry = cache[from + '_' + to];
  if (entry && entry.rate) return entry.rate;
  if (FX_FALLBACK[from + '_' + to]) return FX_FALLBACK[from + '_' + to];
  const k1 = from + '_USD', k2 = 'USD_' + to;
  if (FX_FALLBACK[k1] && FX_FALLBACK[k2]) return FX_FALLBACK[k1] * FX_FALLBACK[k2];
  return 1;
}
async function getFxRateLive(from, to) {
  if (!from || !to || from === to) return 1;
  const cache = loadFxCache();
  const key = from + '_' + to;
  const entry = cache[key];
  const now = Date.now();
  if (entry && entry.rate) {
    if (now - entry.ts > FX_STALE_MS) {
      fetchFxRate(from, to).then(rate => {
        if (rate) { const c = loadFxCache(); c[key] = { rate, ts: Date.now() }; c[to + '_' + from] = { rate: 1 / rate, ts: Date.now() }; saveFxCache(c); }
      }).catch(() => {});
    }
    return entry.rate;
  }
  const rate = await fetchFxRate(from, to);
  if (rate) { cache[key] = { rate, ts: Date.now() }; cache[to + '_' + from] = { rate: 1 / rate, ts: Date.now() }; saveFxCache(cache); return rate; }
  return cachedFxRateLive(from, to);
}
async function convertAmount(amount, fromCur, toCur) {
  if (!fromCur || !toCur || fromCur === toCur) return amount;
  try { const rate = await getFxRateLive(fromCur, toCur); return amount * rate; }
  catch (e) { return amount * cachedFxRateLive(fromCur, toCur); }
}
function hookFxGlobals() {
  try { window.cachedFxRate = cachedFxRateLive; } catch (e) {}
  try { window.fxRate = getFxRateLive; } catch (e) {}
  try { window.getFxRate = getFxRateLive; } catch (e) {}
}
function startFxAutoRefresh() {
  if (fxTimer) clearInterval(fxTimer);
  fxTimer = setInterval(() => {
    if (document.visibilityState === 'visible') {
      refreshAllFxRates(false).then(() => { if (typeof renderAll === 'function') renderAll(); });
    }
  }, FX_REFRESH_MS);
}

/* ============================================================
   CRYPTO — ЖИВОЙ ПОИСК ЧЕРЕЗ COINGECKO
   ============================================================ */
function loadCryptoCache() { try { return JSON.parse(localStorage.getItem(CRYPTO_CACHE_KEY) || '{}'); } catch { return {}; } }
function saveCryptoCache(c) { try { localStorage.setItem(CRYPTO_CACHE_KEY, JSON.stringify(c)); } catch (e) {} }

async function fetchCryptoTopList() {
  const cached = loadCryptoCache();
  if (cached.ts && Date.now() - cached.ts < CRYPTO_CACHE_MS && Array.isArray(cached.list)) return cached.list;
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1&sparkline=false', { cache: 'no-store' });
    const j = await r.json();
    if (Array.isArray(j)) {
      const list = j.map(c => ({ id: c.id, symbol: (c.symbol || '').toUpperCase(), name: c.name || '', thumb: c.image || '', rank: c.market_cap_rank || 0 }));
      saveCryptoCache({ ts: Date.now(), list });
      return list;
    }
  } catch (e) { console.warn('[crypto] top list fetch error', e); }
  return cached.list || [];
}

async function searchCryptoLive(q) {
  const query = (q || '').trim().toLowerCase();
  if (!query) return [];
  const cache = loadCryptoCache();
  const list = Array.isArray(cache.list) ? cache.list : [];
  const local = list.filter(c =>
    c.symbol.toLowerCase().includes(query) ||
    c.name.toLowerCase().includes(query) ||
    c.id.toLowerCase().includes(query)
  ).slice(0, 25);
  if (local.length >= 8) return local;
  if (query.length < 2) return local;
  try {
    const r = await fetch(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(q)}`, { cache: 'no-store' });
    const j = await r.json();
    const coins = Array.isArray(j.coins) ? j.coins : [];
    const merged = [...local];
    coins.slice(0, 25).forEach(c => {
      const sym = (c.symbol || '').toUpperCase();
      if (merged.some(m => m.id === c.id)) return;
      merged.push({ id: c.id, symbol: sym, name: c.name || '', thumb: c.thumb || '', rank: c.market_cap_rank || 9999 });
    });
    return merged.slice(0, 30);
  } catch (e) {
    console.warn('[crypto] search error', e);
    return local;
  }
}

/* ============================================================
   DEPOSIT — РАСЧЁТ
   ============================================================ */
function calcDeposit(acc, asOf) {
  const principal = Number(acc.initialBalance || 0);
  if (acc.type !== 'deposit' || !acc.deposit) {
    return { principal, interest: 0, total: principal, daysElapsed: 0, daysTotal: 0, daysLeft: 0, done: false, rate: 0 };
  }
  const d = acc.deposit;
  const start = new Date(d.startDate).getTime();
  const end = new Date(d.endDate).getTime();
  const now = asOf ? asOf.getTime() : Date.now();
  const rate = Number(d.rate || 0);
  const dayMs = 86400000;
  const daysTotal = Math.max(1, Math.round((end - start) / dayMs));
  const daysElapsed = Math.min(daysTotal, Math.max(0, Math.round((now - start) / dayMs)));
  const yearsElapsed = daysElapsed / 365;
  let interest;
  if (d.capitalization) {
    const months = daysElapsed / 30.4375;
    const monthlyRate = rate / 100 / 12;
    interest = principal * (Math.pow(1 + monthlyRate, months) - 1);
  } else {
    interest = principal * (rate / 100) * yearsElapsed;
  }
  return {
    principal, interest, total: principal + interest,
    daysElapsed, daysTotal, daysLeft: Math.max(0, daysTotal - daysElapsed),
    done: now >= end, rate
  };
}
function depositsList() { return state.accounts.filter(a => a.type === 'deposit'); }

/* ============================================================
   NAV / VIEW ИНЖЕКТ
   ============================================================ */
function injectDepositsNav() {
  const nav = document.getElementById('nav');
  if (!nav) return;
  if (nav.querySelector('[data-view="deposits"]')) return;
  const btn = document.createElement('button');
  btn.className = 'nav-btn';
  btn.dataset.view = 'deposits';
  btn.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18M5 21V8l7-5 7 5v13M9 21v-6h6v6M9 12h.01M15 12h.01"/></svg>
    вклады`;
  btn.onclick = () => {
    if (typeof showView === 'function') showView('deposits');
  };
  const settingsBtn = nav.querySelector('[data-view="settings"]');
  if (settingsBtn) nav.insertBefore(btn, settingsBtn);
  else nav.appendChild(btn);
}
function injectDepositsView() {
  if (document.getElementById('view-deposits')) return;
  const main = document.querySelector('.main');
  if (!main) return;
  const view = document.createElement('section');
  view.className = 'view';
  view.id = 'view-deposits';
  view.innerHTML = `
    <div class="page-head">
      <div><h1>Вклады</h1><div class="sub">Депозиты под проценты</div></div>
      <button class="btn" id="add-deposit-btn">+ Новый вклад</button>
    </div>
    <div class="grid stats" id="deposits-stats"></div>
    <div class="grid acc-grid" id="deposits-grid"></div>
  `;
  const settingsView = document.getElementById('view-settings');
  if (settingsView) main.insertBefore(view, settingsView);
  else main.appendChild(view);
  document.getElementById('add-deposit-btn').onclick = () => openDepositModal(null);
}

/* ============================================================
   RENDER DEPOSITS
   ============================================================ */
function renderDeposits() {
  const grid = document.getElementById('deposits-grid');
  const stats = document.getElementById('deposits-stats');
  if (!grid || !stats) return;
  const base = state.settings.baseCurrency;
  const list = depositsList();
  let totalPrincipal = 0, totalInterest = 0, totalCurrent = 0;
  list.forEach(a => {
    const c = calcDeposit(a);
    const cur = a.currency || base;
    const rate = cachedFxRateLive(cur, base);
    totalPrincipal += c.principal * rate;
    totalInterest += c.interest * rate;
    totalCurrent += c.total * rate;
  });
  stats.innerHTML = `
    <div class="card"><div class="stat-label">Всего вкладов</div><div class="stat-value">${list.length}</div></div>
    <div class="card"><div class="stat-label">Вложено</div><div class="stat-value">${fmt(totalPrincipal)}</div></div>
    <div class="card"><div class="stat-label">Начислено процентов</div><div class="stat-value pos">+${fmt(totalInterest)}</div></div>
    <div class="card"><div class="stat-label">Текущая стоимость</div><div class="stat-value">${fmt(totalCurrent)}</div></div>
  `;
  if (list.length === 0) {
    grid.innerHTML = `<div class="empty" style="grid-column:1/-1"><div class="big">🏦</div>Пока нет вкладов. Нажмите «+ Новый вклад».</div>`;
    return;
  }
  grid.innerHTML = list.map(a => {
    const c = calcDeposit(a);
    const cur = a.currency || base;
    const daysLeft = c.daysLeft;
    const pct = c.daysTotal > 0 ? Math.min(100, (c.daysElapsed / c.daysTotal) * 100) : 0;
    const finish = c.done ? 'срок истёк' : `осталось ${daysLeft} дн.`;
    return `<div class="acc-card" style="--c:${a.color || '#4fbf8b'}">
      <div class="head">
        <div><div class="name">${a.name}</div><div class="type">Вклад · ${c.rate}% ${a.deposit && a.deposit.capitalization ? '(кап.)' : ''}</div></div>
        <div class="row-actions" style="opacity:1;">
          <button class="icon-btn" onclick="openDepositModal(accById('${a.id}'))">✎</button>
          <button class="icon-btn" onclick="closeDeposit('${a.id}')">✕</button>
        </div>
      </div>
      <div class="bal">${fmt(c.total, cur)}</div>
      <div class="meta" style="font-size:11.5px;color:var(--text-dim);margin-top:6px;">
        Вложено: ${fmt(c.principal, cur)} · Проценты: <span style="color:var(--green)">+${fmt(c.interest, cur)}</span><br>
        ${a.deposit ? a.deposit.startDate + ' → ' + a.deposit.endDate : ''} · ${finish}
      </div>
      <div class="bar-track" style="margin-top:10px;"><div class="bar-fill" style="width:${pct}%;background:${a.color || '#4fbf8b'}"></div></div>
      <div class="foot" style="gap:6px;flex-wrap:wrap;">
        <button class="btn ghost small" onclick="closeDeposit('${a.id}')">Закрыть досрочно</button>
        <span></span>
      </div>
    </div>`;
  }).join('');
}

/* ============================================================
   DEPOSIT MODAL
   ============================================================ */
function openDepositModal(acc) {
  const base = state.settings.baseCurrency;
  const palettes = (typeof PALETTE !== 'undefined') ? PALETTE : ['#d4a54a', '#4fbf8b', '#e36565', '#6fa8d6'];
  const a = acc || { name: '', color: palettes[1], currency: base, initialBalance: 0, deposit: { rate: 12, capitalization: true, startDate: todayStr(), endDate: '' } };
  const d = a.deposit || { rate: 12, capitalization: true, startDate: todayStr(), endDate: '' };
  const swatches = palettes.map(c => `<div class="sw ${a.color === c ? 'sel' : ''}" data-c="${c}" style="background:${c}"></div>`).join('');
  const paymentAccs = state.accounts.filter(x => (x.type === 'cash' || x.type === 'bank') && x.id !== a.id);
  const payOpts = ['<option value="">— не списывать —</option>'].concat(paymentAccs.map(x => `<option value="${x.id}">${x.name} — ${fmt(cashAccountBalance(x), x.currency || base)}</option>`)).join('');
  const currencyOpts = (typeof currencyOptionsHtml === 'function') ? currencyOptionsHtml(a.currency || base) : '';

  openModal(`
    <h2>${acc ? 'Изменить вклад' : 'Новый вклад'}</h2>
    <div class="field"><label>Название</label><input type="text" id="d-name" value="${a.name || ''}" placeholder="напр. Вклад в Сбере"></div>
    <div class="field-row">
      <div class="field"><label>Основная сумма</label><input type="number" step="0.01" id="d-amount" value="${a.initialBalance || 0}"></div>
      <div class="field"><label>Валюта</label><select id="d-currency">${currencyOpts}</select></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Ставка, % годовых</label><input type="number" step="0.01" id="d-rate" value="${d.rate}"></div>
      <div class="field"><label>Срок, мес.</label><input type="number" id="d-months" value="12"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Дата начала</label><input type="date" id="d-start" value="${d.startDate}"></div>
      <div class="field"><label>Дата окончания</label><input type="date" id="d-end" value="${d.endDate || ''}"></div>
    </div>
    <div class="field">
      <label><input type="checkbox" id="d-cap" ${d.capitalization ? 'checked' : ''}> Капитализация процентов (ежемесячно)</label>
    </div>
    ${!acc ? `<div class="field"><label>Списать с счёта</label><select id="d-payacc">${payOpts}</select><div class="hint">Сумма вклада будет списана с выбранного счёта.</div></div>` : ''}
    <div class="field"><label>Цвет</label><div class="color-swatches" id="d-color">${swatches}</div></div>
    <div class="modal-actions">
      <button class="btn secondary" onclick="closeModal()">Отмена</button>
      <button class="btn" id="d-save-btn">${acc ? 'Сохранить' : 'Создать'}</button>
    </div>
  `);

  // авто-срок: при вводе месяцев — считаем end
  const monthsInput = document.getElementById('d-months');
  const endInput = document.getElementById('d-end');
  const startInput = document.getElementById('d-start');
  const recalcEnd = () => {
    if (!startInput.value) return;
    const m = parseInt(monthsInput.value, 10) || 0;
    if (m <= 0) return;
    const d1 = new Date(startInput.value);
    d1.setMonth(d1.getMonth() + m);
    endInput.value = d1.toISOString().slice(0, 10);
  };
  monthsInput.addEventListener('input', recalcEnd);
  startInput.addEventListener('change', recalcEnd);
  if (!acc) recalcEnd();

  let selColor = a.color || palettes[1];
  document.getElementById('d-color').addEventListener('click', e => {
    if (e.target.dataset.c) {
      selColor = e.target.dataset.c;
      document.querySelectorAll('#d-color .sw').forEach(s => s.classList.toggle('sel', s.dataset.c === selColor));
    }
  });

  document.getElementById('d-save-btn').onclick = async () => {
    const name = document.getElementById('d-name').value.trim();
    const amount = parseFloat(document.getElementById('d-amount').value);
    const rate = parseFloat(document.getElementById('d-rate').value);
    const startDate = document.getElementById('d-start').value || todayStr();
    const endDate = document.getElementById('d-end').value;
    const capitalization = document.getElementById('d-cap').checked;
    const currency = document.getElementById('d-currency').value || base;
    if (!name) { toast('Укажите название', 'err'); return; }
    if (!(amount > 0)) { toast('Укажите сумму', 'err'); return; }
    if (!(rate > 0)) { toast('Укажите ставку', 'err'); return; }
    if (!endDate) { toast('Укажите дату окончания', 'err'); return; }
    if (endDate <= startDate) { toast('Дата окончания должна быть позже начала', 'err'); return; }

    const payload = {
      id: acc ? acc.id : uid(),
      name, type: 'deposit', color: selColor,
      currency, initialBalance: amount,
      deposit: { rate, capitalization, startDate, endDate }
    };

    if (acc) {
      const idx = state.accounts.findIndex(x => x.id === acc.id);
      state.accounts[idx] = Object.assign({}, state.accounts[idx], payload);
      persist(); closeModal(); renderAll();
      toast('Вклад обновлён', 'ok');
    } else {
      const payAccId = document.getElementById('d-payacc').value;
      state.accounts.push(payload);
      if (payAccId) {
        const payAcc = accById(payAccId);
        if (payAcc) {
          const payCur = payAcc.currency || base;
          const amountInPayCur = await convertAmount(amount, currency, payCur);
          const cat = getPortfolioCategory();
          state.transactions.push({
            id: uid(), type: 'expense', date: todayStr(),
            amount: amountInPayCur, accountId: payAccId, categoryId: cat.id,
            note: 'Открытие вклада: ' + name, holdingId: payload.id, holdingAccId: payload.id
          });
        }
      }
      persist(); closeModal(); renderAll();
      toast('Вклад создан', 'ok');
    }
  };
}

function closeDeposit(accId) {
  const acc = accById(accId);
  if (!acc || acc.type !== 'deposit') return;
  const c = calcDeposit(acc);
  const base = state.settings.baseCurrency;
  const cur = acc.currency || base;
  const payAccs = state.accounts.filter(x => (x.type === 'cash' || x.type === 'bank') && x.id !== accId);
  if (payAccs.length === 0) { toast('Нет счетов для возврата', 'err'); return; }
  const opts = payAccs.map(x => `<option value="${x.id}">${x.name} — ${fmt(cashAccountBalance(x), x.currency || base)}</option>`).join('');

  openModal(`
    <h2>Закрыть вклад</h2>
    <div class="field"><label>Вклад</label><input type="text" value="${acc.name}" disabled></div>
    <div class="hint">Вложено: ${fmt(c.principal, cur)}<br>Проценты: <strong style="color:var(--green)">+${fmt(c.interest, cur)}</strong><br>Итого к возврату: <strong>${fmt(c.total, cur)}</strong></div>
    <div class="field"><label>Зачислить на счёт</label><select id="cd-account">${opts}</select></div>
    <div class="modal-actions">
      <button class="btn secondary" onclick="closeModal()">Отмена</button>
      <button class="btn" id="cd-save-btn">Закрыть и вернуть</button>
    </div>
  `);

  document.getElementById('cd-save-btn').onclick = async () => {
    const destId = document.getElementById('cd-account').value;
    const dest = accById(destId);
    if (!dest) return;
    const destCur = dest.currency || base;
    const totalInDestCur = await convertAmount(c.total, cur, destCur);
    const interestInDestCur = await convertAmount(c.interest, cur, destCur);

    // удалить старую транзакцию "Открытие вклада"
    state.transactions = state.transactions.filter(t => !(t.holdingId === accId && t.note && t.note.indexOf('Открытие вклада') === 0));

    // вернуть тело + проценты
    const cat = getPortfolioCategory();
    state.transactions.push({
      id: uid(), type: 'income', date: todayStr(),
      amount: totalInDestCur, accountId: destId, categoryId: cat.id,
      note: 'Закрытие вклада: ' + acc.name + (interestInDestCur > 0 ? ' (+' + fmt(interestInDestCur, destCur) + ')' : '')
    });

    // удалить сам аккаунт-вклад
    state.accounts = state.accounts.filter(a => a.id !== accId);

    persist(); closeModal(); renderAll();
    toast('Вклад закрыт, возвращено ' + fmt(totalInDestCur, destCur), 'ok');
  };
}

/* ============================================================
   ACCOUNTS
   ============================================================ */
function renderAccountsNative() {
  const grid = document.getElementById('acc-grid');
  if (!grid) return;
  if (state.accounts.length === 0) {
    grid.innerHTML = `<div class="empty" style="grid-column:1/-1"><div class="big">＄</div>Пока нет счетов</div>`;
    return;
  }
  const base = state.settings.baseCurrency;
  const tL = (typeof typeLabel === 'function') ? typeLabel : (t) => t;
  grid.innerHTML = state.accounts.map(a => {
    if (a.type === 'deposit') {
      const c = calcDeposit(a);
      const cur = a.currency || base;
      const pct = c.daysTotal > 0 ? Math.min(100, (c.daysElapsed / c.daysTotal) * 100) : 0;
      return `<div class="acc-card" style="--c:${a.color || '#4fbf8b'}">
        <div class="head">
          <div><div class="name">${a.name}</div><div class="type">Вклад · ${c.rate}%</div></div>
          <div class="row-actions" style="opacity:1;">
            <button class="icon-btn" onclick="openDepositModal(accById('${a.id}'))">✎</button>
            <button class="icon-btn" onclick="closeDeposit('${a.id}')">✕</button>
          </div>
        </div>
        <div class="bal">${fmt(c.total, cur)}</div>
        <div class="meta" style="font-size:11.5px;color:var(--text-dim);margin-top:6px;">
          Проценты: <span style="color:var(--green)">+${fmt(c.interest, cur)}</span> · ${c.done ? 'срок истёк' : 'осталось ' + c.daysLeft + ' дн.'}
        </div>
        <div class="bar-track" style="margin-top:10px;"><div class="bar-fill" style="width:${pct}%;background:${a.color || '#4fbf8b'}"></div></div>
      </div>`;
    }
    let nv = 0, nc = base;
    if (a.type === 'cash' || a.type === 'bank') { nv = cashAccountBalance(a); nc = a.currency || base; }
    else if (a.type === 'crypto') { nv = cryptoAccountValue(a); nc = (a.crypto && a.crypto.currency) || base; }
    else if (a.type === 'stocks') { nv = stocksAccountValue(a); nc = a.currency || 'USD'; }
    const bv = accountValue(a);
    const showBase = nc !== base;
    let meta = '';
    if (a.type === 'crypto') {
      const addr = a.crypto && a.crypto.address;
      meta = `${(a.crypto && a.crypto.network) || ''} · валюта: ${nc} · ` + (addr ? addr.slice(0, 6) + '…' + addr.slice(-4) : 'адрес не указан');
    } else if (a.type === 'stocks') { meta = `${(a.holdings || []).length} позиций · валюта: ${nc}`; }
    else { meta = nc; }
    return `<div class="acc-card" style="--c:${a.color}">
      <div class="head">
        <div><div class="name">${a.name}</div><div class="type">${tL(a.type)}</div></div>
        <div class="row-actions" style="opacity:1;">
          <button class="icon-btn" onclick="openAccModal(accById('${a.id}'))">✎</button>
          <button class="icon-btn" onclick="deleteAccount('${a.id}')">✕</button>
        </div>
      </div>
      <div class="bal">${fmt(nv, nc)}</div>
      ${showBase ? `<div class="meta" style="font-size:11.5px;color:var(--text-dim);margin-top:2px;">≈ ${fmt(bv)}</div>` : ''}
      <div class="meta">${meta}</div>
      <div class="foot">
        ${a.type === 'crypto' ? `<button class="btn ghost small" onclick="refreshCrypto('${a.id}')">↻ Обновить курс</button>` : ''}
        ${a.type === 'stocks' ? `<button class="btn ghost small" onclick="showView('stocks')">Портфель →</button>` : '<span></span>'}
      </div>
    </div>`;
  }).join('');
}

/* ============================================================
   TRANSACTIONS
   ============================================================ */
function fmtDateShort(d) {
  try {
    const dt = new Date(d);
    const now = new Date();
    const sameYear = dt.getFullYear() === now.getFullYear();
    return dt.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: '2-digit' }) });
  } catch (e) { return d; }
}
function renderTransactionsCombined() {
  const tbody = document.getElementById('tx-table');
  const emptyEl = document.getElementById('tx-empty');
  const base = state.settings.baseCurrency;
  const sorted = [...state.transactions].sort((a, b) => new Date(b.date) - new Date(a.date));
  if (emptyEl) emptyEl.style.display = sorted.length ? 'none' : 'block';

  if (tbody) {
    if (sorted.length === 0) tbody.innerHTML = '';
    else tbody.innerHTML = sorted.map(t => {
      const acc = accById(t.accountId);
      const cat = catById(t.categoryId);
      const cur = acc ? (acc.currency || base) : base;
      const sign = t.type === 'income' ? '+' : (t.type === 'expense' ? '−' : '');
      const cls = t.type === 'income' ? 'pos' : (t.type === 'expense' ? 'neg' : '');
      let accLabel = acc ? acc.name : '—';
      if (t.type === 'transfer') {
        const to = accById(t.toAccountId);
        accLabel = `${acc ? acc.name : '?'} → ${to ? to.name : '?'}`;
      }
      return `<tr>
        <td>${t.date}</td>
        <td>${accLabel}</td>
        <td>${cat ? `<span class="tag"><span class="swatch" style="background:${cat.color}"></span>${cat.name}</span>` : '—'}</td>
        <td style="color:var(--text-dim)">${t.note || ''}</td>
        <td class="amount ${cls}">${sign}${fmt(t.amount, cur).replace('−', '')}</td>
        <td><div class="row-actions">
          <button class="icon-btn" onclick="editTx('${t.id}')">✎</button>
          <button class="icon-btn" onclick="deleteTx('${t.id}')">✕</button>
        </div></td>
      </tr>`;
    }).join('');
  }

  const table = tbody ? tbody.closest('table') : null;
  if (table) {
    const card = table.parentElement;
    if (card && !document.getElementById('tx-mobile-list')) {
      const wrap = document.createElement('div');
      wrap.id = 'tx-mobile-list';
      card.insertBefore(wrap, table);
    }
  }
  const wrap = document.getElementById('tx-mobile-list');
  if (!wrap) return;
  if (sorted.length === 0) { wrap.innerHTML = ''; return; }
  const groups = new Map();
  sorted.forEach(t => { const k = t.date; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(t); });
  wrap.innerHTML = [...groups.entries()].map(([date, items]) => {
    const daySum = items.reduce((s, t) => s + (t.type === 'income' ? t.amount : (t.type === 'expense' ? -t.amount : 0)), 0);
    const dayCls = daySum >= 0 ? 'pos' : 'neg';
    const rows = items.map(t => {
      const acc = accById(t.accountId);
      const cat = catById(t.categoryId);
      const cur = acc ? (acc.currency || base) : base;
      const sign = t.type === 'income' ? '+' : (t.type === 'expense' ? '−' : '↔');
      const cls = t.type === 'income' ? 'pos' : (t.type === 'expense' ? 'neg' : 'tr');
      let accLabel = acc ? acc.name : '—';
      if (t.type === 'transfer') { const to = accById(t.toAccountId); accLabel = `${acc ? acc.name : '?'} → ${to ? to.name : '?'}`; }
      const catColor = cat ? cat.color : '#8b93a1';
      const catName = cat ? cat.name : 'Без категории';
      const noteHtml = t.note ? `<div class="m-tx-note">${t.note}</div>` : '';
      return `<div class="m-tx-row" data-id="${t.id}">
        <div class="m-tx-cat"><span class="m-tx-dot" style="background:${catColor}"></span><span class="m-tx-catname">${catName}</span></div>
        <div class="m-tx-meta"><span class="m-tx-acc">${accLabel}</span>${noteHtml}</div>
        <div class="m-tx-amt ${cls}">${sign}${fmt(t.amount, cur).replace('−', '')}</div>
        <div class="m-tx-actions">
          <button class="m-tx-btn" onclick="event.stopPropagation();editTx('${t.id}')">✎</button>
          <button class="m-tx-btn m-tx-del" onclick="event.stopPropagation();deleteTx('${t.id}')">✕</button>
        </div>
      </div>`;
    }).join('');
    return `<div class="m-tx-day">
      <div class="m-tx-dayhead"><span>${fmtDateShort(date)}</span><span class="${dayCls}">${daySum >= 0 ? '+' : '−'}${fmt(Math.abs(daySum), base).replace('−', '')}</span></div>
      ${rows}
    </div>`;
  }).join('');
  wrap.querySelectorAll('.m-tx-row').forEach(el => {
    el.addEventListener('click', () => { const id = el.dataset.id; if (id && typeof editTx === 'function') editTx(id); });
  });
  applyTxVisibility();
}
function applyTxVisibility() {
  const isMobile = document.body.classList.contains('mobile-mode');
  const view = document.getElementById('view-transactions');
  if (!view) return;
  const table = view.querySelector('.card > table');
  if (table) table.style.display = isMobile ? 'none' : '';
  const wrap = document.getElementById('tx-mobile-list');
  if (wrap) wrap.style.display = isMobile ? 'block' : 'none';
}

/* ============================================================
   GOALS
   ============================================================ */
function computeGoalBalance(g) {
  const initial = Number(g.initialAmount || 0);
  let fromTx = 0;
  state.transactions.forEach(t => { if (t.goalId === g.id) { if (t.type === 'expense') fromTx += t.amount; else if (t.type === 'income') fromTx -= t.amount; } });
  return initial + fromTx;
}
function getGoalCategory() {
  let cat = state.categories.find(c => c.name === GOAL_CAT_NAME && c.kind === 'expense');
  if (!cat) { cat = { id: 'goal_cat_' + Math.random().toString(36).slice(2, 8), name: GOAL_CAT_NAME, color: '#8b93a1', kind: 'expense' }; state.categories.push(cat); }
  return cat;
}
function accountsForGoal() { return state.accounts.filter(a => a.type === 'cash' || a.type === 'bank'); }
function renderGoalsNative() {
  const grid = document.getElementById('goals-grid');
  if (!grid) return;
  if (state.goals.length === 0) { grid.innerHTML = `<div class="empty" style="grid-column:1/-1"><div class="big">◎</div>Пока нет целей</div>`; return; }
  grid.innerHTML = state.goals.map(g => {
    const bal = computeGoalBalance(g);
    const pct = Math.min(100, (bal / g.targetAmount) * 100);
    const daysLeft = g.deadline ? Math.ceil((new Date(g.deadline) - new Date()) / 86400000) : null;
    const acc = g.accountId ? accById(g.accountId) : null;
    const accLine = acc ? `<div class="meta" style="font-size:11.5px;color:var(--text-dim);margin-top:4px;">счёт: ${acc.name}</div>` : `<div class="meta" style="font-size:11.5px;color:var(--text-dim);margin-top:4px;">счёт: любой</div>`;
    return `<div class="acc-card" style="--c:${g.color}">
      <div class="head">
        <div><div class="name">${g.name}</div><div class="type">${g.deadline ? 'до ' + g.deadline : 'без срока'}</div></div>
        <div class="row-actions" style="opacity:1;">
          <button class="icon-btn" onclick="editGoal('${g.id}')">✎</button>
          <button class="icon-btn" onclick="deleteGoal('${g.id}')">✕</button>
        </div>
      </div>
      <div class="bal">${fmt(bal)} <span style="font-size:13px;color:var(--text-dim);font-weight:400;">/ ${fmt(g.targetAmount)}</span></div>
      <div style="height:8px"></div>
      <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${g.color}"></div></div>
      <div class="meta" style="margin-top:8px;">${pct.toFixed(0)}% ${daysLeft != null ? (daysLeft >= 0 ? `· ${daysLeft} дн. осталось` : '· срок прошёл') : ''}</div>
      ${accLine}
      <div class="foot" style="gap:6px;flex-wrap:wrap;">
        <button class="btn ghost small" onclick="addGoalFunds('${g.id}')">+ Внести</button>
        <button class="btn ghost small" onclick="withdrawGoalFunds('${g.id}')">− Вывести</button>
      </div>
    </div>`;
  }).join('');
}
function addGoalFundsModal(goalId) {
  const g = state.goals.find(x => x.id === goalId);
  if (!g) return;
  const accs = accountsForGoal();
  if (accs.length === 0) { toast('Нет счетов', 'err'); return; }
  const base = state.settings.baseCurrency;
  const accOpts = accs.map(a => { const cur = a.currency || base; const bal = cashAccountBalance(a); const sel = (g.accountId === a.id) ? 'selected' : ''; return `<option value="${a.id}" ${sel}>${a.name} — ${fmt(bal, cur)}</option>`; }).join('');
  const current = computeGoalBalance(g);
  const remain = Math.max(0, g.targetAmount - current);
  openModal(`
    <h2>Пополнить цель</h2>
    <div class="field"><label>Цель</label><input type="text" value="${g.name}" disabled></div>
    <div class="field"><label>Сумма пополнения</label><input type="number" step="0.01" id="gf-amount" value="${remain > 0 ? remain.toFixed(2) : ''}"></div>
    <div class="field"><label>Со счёта</label><select id="gf-account">${accOpts}</select></div>
    <div class="hint">Уже накоплено: <strong>${fmt(current)}</strong> из ${fmt(g.targetAmount)}</div>
    <div class="modal-actions">
      <button class="btn secondary" onclick="closeModal()">Отмена</button>
      <button class="btn" id="gf-save-btn">Внести</button>
    </div>`);
  setTimeout(() => { const inp = document.getElementById('gf-amount'); if (inp) { inp.focus(); inp.select(); } }, 100);
  document.getElementById('gf-save-btn').onclick = () => {
    const amt = parseFloat(document.getElementById('gf-amount').value);
    const accId = document.getElementById('gf-account').value;
    if (!(amt > 0)) { toast('Укажите корректную сумму', 'err'); return; }
    const acc = accById(accId);
    if (!acc) { toast('Счёт не найден', 'err'); return; }
    const cur = acc.currency || base;
    const bal = cashAccountBalance(acc);
    if (bal < amt) { if (!confirm(`На счёте «${acc.name}» только ${fmt(bal, cur)}. Продолжить?`)) return; }
    const cat = getGoalCategory();
    state.transactions.push({ id: uid(), type: 'expense', date: todayStr(), amount: amt, accountId: accId, categoryId: cat.id, note: 'Цель: ' + g.name, goalId: g.id });
    if (!g.accountId) g.accountId = accId;
    persist(); closeModal(); renderAll();
    toast('Цель пополнена на ' + fmt(amt, cur), 'ok');
  };
}
function withdrawGoalFundsModal(goalId) {
  const g = state.goals.find(x => x.id === goalId);
  if (!g) return;
  const balance = computeGoalBalance(g);
  if (balance <= 0) { toast('В цели нет накоплений', 'err'); return; }
  const accs = accountsForGoal();
  if (accs.length === 0) { toast('Нет доступных счетов', 'err'); return; }
  const base = state.settings.baseCurrency;
  const accOpts = accs.map(a => { const cur = a.currency || base; const sel = (g.accountId === a.id) ? 'selected' : ''; return `<option value="${a.id}" ${sel}>${a.name} (${cur})</option>`; }).join('');
  openModal(`
    <h2>Вывести из цели</h2>
    <div class="field"><label>Цель</label><input type="text" value="${g.name}" disabled></div>
    <div class="field"><label>Сумма вывода</label><input type="number" step="0.01" id="gw-amount" value="${balance.toFixed(2)}"><div class="hint">В цели доступно: ${fmt(balance)}</div></div>
    <div class="field"><label>На счёт</label><select id="gw-account">${accOpts}</select></div>
    <div class="modal-actions">
      <button class="btn secondary" onclick="closeModal()">Отмена</button>
      <button class="btn" id="gw-save-btn">Вывести</button>
    </div>`);
  setTimeout(() => { const inp = document.getElementById('gw-amount'); if (inp) { inp.focus(); inp.select(); } }, 100);
  document.getElementById('gw-save-btn').onclick = () => {
    const amt = parseFloat(document.getElementById('gw-amount').value);
    const accId = document.getElementById('gw-account').value;
    if (!(amt > 0)) { toast('Укажите корректную сумму', 'err'); return; }
    if (amt > balance) { toast('Сумма больше накоплений', 'err'); return; }
    const acc = accById(accId);
    if (!acc) return;
    const cat = getGoalCategory();
    state.transactions.push({ id: uid(), type: 'income', date: todayStr(), amount: amt, accountId: accId, categoryId: cat.id, note: 'Возврат из цели: ' + g.name, goalId: g.id });
    persist(); closeModal(); renderAll();
    toast('Возвращено на ' + acc.name + ': ' + fmt(amt, acc.currency || base), 'ok');
  };
}
function goalFormNative(goal) {
  const g = goal || { name: '', targetAmount: '', initialAmount: 0, deadline: '', color: (typeof PALETTE !== 'undefined') ? PALETTE[0] : '#d4a54a', accountId: '' };
  const palette = (typeof PALETTE !== 'undefined') ? PALETTE : ['#d4a54a', '#4fbf8b', '#e36565', '#6fa8d6'];
  const swatches = palette.map(c => `<div class="sw ${g.color === c ? 'sel' : ''}" data-c="${c}" style="background:${c}"></div>`).join('');
  const accs = accountsForGoal();
  const accOpts = ['<option value="">— выбрать при пополнении —</option>'].concat(accs.map(a => `<option value="${a.id}" ${g.accountId === a.id ? 'selected' : ''}>${a.name}</option>`)).join('');
  const initialVal = (goal && (goal.initialAmount != null ? goal.initialAmount : goal.currentAmount)) || 0;
  return `
    <h2>${goal ? 'Изменить цель' : 'Новая цель'}</h2>
    <div class="field"><label>Название</label><input type="text" id="g-name" value="${g.name}"></div>
    <div class="field-row">
      <div class="field"><label>Целевая сумма</label><input type="number" step="0.01" id="g-target" value="${g.targetAmount}"></div>
      <div class="field"><label>Стартовая сумма</label><input type="number" step="0.01" id="g-initial" value="${initialVal}"></div>
    </div>
    <div class="field"><label>Счёт по умолчанию</label><select id="g-account">${accOpts}</select></div>
    <div class="field"><label>Срок (необязательно)</label><input type="date" id="g-deadline" value="${g.deadline || ''}"></div>
    <div class="field"><label>Цвет</label><div class="color-swatches" id="g-color">${swatches}</div></div>
    <div class="modal-actions">
      <button class="btn secondary" onclick="closeModal()">Отмена</button>
      <button class="btn" id="g-save-btn">Сохранить</button>
    </div>`;
}
function openGoalModalNative(goal) {
  openModal(goalFormNative(goal));
  let color = goal ? goal.color : ((typeof PALETTE !== 'undefined') ? PALETTE[0] : '#d4a54a');
  document.getElementById('g-color').addEventListener('click', e => {
    if (e.target.dataset.c) { color = e.target.dataset.c; document.querySelectorAll('#g-color .sw').forEach(s => s.classList.toggle('sel', s.dataset.c === color)); }
  });
  document.getElementById('g-save-btn').onclick = () => {
    const name = document.getElementById('g-name').value.trim();
    const targetAmount = parseFloat(document.getElementById('g-target').value);
    if (!name || !targetAmount) { toast('Заполните название и целевую сумму', 'err'); return; }
    const initial = parseFloat(document.getElementById('g-initial').value) || 0;
    const accountId = document.getElementById('g-account').value || '';
    const deadline = document.getElementById('g-deadline').value || '';
    const payload = { id: goal ? goal.id : uid(), name, targetAmount, initialAmount: initial, deadline, color, accountId };
    if (goal) { const idx = state.goals.findIndex(x => x.id === goal.id); state.goals[idx] = Object.assign({}, state.goals[idx], payload); }
    else { state.goals.push(payload); }
    persist(); closeModal(); renderAll();
    toast('Цель сохранена', 'ok');
  };
}

/* ============================================================
   PORTFOLIO / CRYPTO
   ============================================================ */
function getPortfolioCategory() {
  let cat = state.categories.find(c => c.name === PORTFOLIO_CAT_NAME && c.kind === 'expense');
  if (!cat) { cat = { id: 'portfolio_cat_auto', name: PORTFOLIO_CAT_NAME, color: '#15f211', kind: 'expense' }; state.categories.push(cat); }
  return cat;
}

const __stockModalRead  = { payAccId: null, accId: null, shares: null, price: null, ticker: null };
const __cryptoModalRead = { payAccId: null, accId: null, amount: null, price: null, ticker: null };

function enhanceStockModal() {
  if (document.getElementById('sp-payacc-field')) return;
  const modal = document.getElementById('modal');
  if (!modal) return;
  const saveBtn = document.getElementById('sp-save-btn');
  if (!saveBtn) return;
  const h2 = modal.querySelector('h2');
  if (h2 && /Изменить/i.test(h2.textContent)) return;
  const payAccounts = state.accounts.filter(a => a.type === 'cash' || a.type === 'bank');
  if (payAccounts.length === 0) return;
  const base = state.settings.baseCurrency;
  const opts = payAccounts.map(a => { const cur = a.currency || base; return `<option value="${a.id}">${a.name} — ${fmt(cashAccountBalance(a), cur)}</option>`; }).join('');
  const field = document.createElement('div');
  field.className = 'field';
  field.id = 'sp-payacc-field';
  field.innerHTML = `<label>Списать со счёта</label><select id="sp-payacc">${opts}</select><div class="hint">Сумма спишется с выбранного счёта.</div>`;
  const actions = modal.querySelector('.modal-actions');
  if (actions) actions.parentNode.insertBefore(field, actions);
  saveBtn.addEventListener('click', () => {
    __stockModalRead.payAccId = (document.getElementById('sp-payacc') || {}).value || null;
    __stockModalRead.accId    = (document.getElementById('sp-account') || {}).value || null;
    __stockModalRead.shares   = parseFloat((document.getElementById('sp-shares') || {}).value) || 0;
    __stockModalRead.price    = parseFloat((document.getElementById('sp-price')  || {}).value) || 0;
    __stockModalRead.ticker   = ((document.getElementById('sp-ticker') || {}).value || '').trim().toUpperCase();
  }, true);
  saveBtn.addEventListener('click', () => {
    setTimeout(async () => {
      if (document.getElementById('overlay').classList.contains('active')) return;
      const v = __stockModalRead;
      if (!v.payAccId || !v.shares || !v.price || !v.ticker || !v.accId) return;
      const buyAcc = accById(v.payAccId);
      const stockAcc = accById(v.accId);
      if (!buyAcc || !stockAcc) return;
      const stockCur = stockAcc.currency || 'USD';
      const accCur = buyAcc.currency || state.settings.baseCurrency;
      const totalInAccCur = await convertAmount(v.shares * v.price, stockCur, accCur);
      const candidates = (stockAcc.holdings || []).filter(h => h.ticker === v.ticker);
      const holdingId = candidates.length > 0 ? candidates[candidates.length - 1].id : null;
      const cat = getPortfolioCategory();
      state.transactions.push({ id: uid(), type: 'expense', date: todayStr(), amount: totalInAccCur, accountId: v.payAccId, categoryId: cat.id, note: 'Покупка ' + v.ticker, holdingId, holdingAccId: v.accId });
      persist();
      if (typeof renderAll === 'function') renderAll();
      if (typeof toast === 'function') toast('Списано ' + fmt(totalInAccCur, accCur), 'ok');
    }, 150);
  });
}

/* ============================================================
   КРИПТА — НОВАЯ ФОРМА С ЖИВЫМ ПОИСКОМ
   ============================================================ */
function renderCryptoHoldingFormNew(accId, holdId) {
  const acc = accById(accId) || { id: uid(), name: 'Крипто портфель', type: 'crypto', color: '#4fbf8b', crypto: { holdings: [] } };
  const holdings = getCryptoHoldings(acc);
  const holding = holdId ? holdings.find(h => h.id === holdId) : null;
  const payAccounts = state.accounts.filter(a => a.type === 'cash' || a.type === 'bank');
  const base = state.settings.baseCurrency;
  const payOpts = payAccounts.map(a => { const cur = a.currency || base; return `<option value="${a.id}">${a.name} — ${fmt(cashAccountBalance(a), cur)}</option>`; }).join('');

  const cryptoAccounts = state.accounts.filter(a => a.type === 'crypto');
  const accOpts = cryptoAccounts.map(a => `<option value="${a.id}" ${a.id === acc.id ? 'selected' : ''}>${a.name}</option>`).join('');

  return `
    <h2>${holdId ? 'Изменить позицию' : 'Новая позиция'}</h2>
    <div class="field"><label>Портфель</label><select id="crypto-account">${accOpts}</select></div>

    <div class="field" style="position:relative;">
      <label>Поиск монеты</label>
      <input type="text" id="crypto-search" placeholder="Начните вводить: btc, eth, sol..." autocomplete="off" value="${holding ? holding.ticker : ''}" style="margin-bottom:4px;">
      <div id="crypto-search-dropdown" style="position:absolute;left:0;right:0;top:100%;background:var(--bg-elev);border:1px solid var(--border);border-radius:12px;max-height:260px;overflow:auto;z-index:10;display:none;box-shadow:var(--shadow-md);"></div>
      <div class="hint" id="crypto-selected-label">${holding ? `выбрано: <strong>${holding.ticker}</strong> — ${holding.name || ''}` : 'выберите монету из списка'}</div>
    </div>

    <div class="field-row">
      <div class="field"><label>Количество</label><input type="number" step="any" id="crypto-amount" value="${holding ? holding.amount : ''}" placeholder="0.5"></div>
      <div class="field"><label>Цена покупки</label><input type="text" inputmode="decimal" id="crypto-buy-price" value="${holding ? (holding.buyPriceInput ?? holding.buyPrice ?? '') : ''}" placeholder="0.00"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Текущая цена (опц.)</label><input type="number" step="any" id="crypto-last-price" value="${holding && holding.lastPrice != null ? holding.lastPrice : ''}"></div>
      <div class="field"><label>Дата покупки</label><input type="date" id="crypto-date" value="${holding ? (holding.buyDate || todayStr()) : todayStr()}"></div>
    </div>
    <div class="field"><label>Адрес кошелька (для API)</label><input type="text" id="crypto-address" value="${(acc.crypto && acc.crypto.address) || ''}" placeholder="BTC/ETH адрес"></div>

    ${!holdId ? `<div class="field"><label>Списать со счёта</label><select id="crypto-payacc">${payOpts}</select><div class="hint">Сумма спишется с выбранного счёта. Валюты сконвертируются автоматически.</div></div>` : ''}

    <div class="modal-actions">
      <button class="btn secondary" onclick="closeModal()">Отмена</button>
      <button class="btn" id="crypto-save-btn">Сохранить</button>
    </div>
  `;
}

function openCryptoHoldingModalNew(accId, holdId) {
  if (state.accounts.filter(a => a.type === 'crypto').length === 0) {
    const acc = { id: uid(), name: 'Крипто портфель', type: 'crypto', color: '#4fbf8b', crypto: { holdings: [] } };
    state.accounts.push(acc);
  }
  const targetAccId = accId || (state.accounts.find(a => a.type === 'crypto') || {}).id || null;
  openModal(renderCryptoHoldingFormNew(targetAccId, holdId));

  // инициализируем кэш топ монет
  fetchCryptoTopList();

  const searchInput = document.getElementById('crypto-search');
  const dropdown = document.getElementById('crypto-search-dropdown');
  const selectedLabel = document.getElementById('crypto-selected-label');
  let selectedCoin = holdId ? (getCryptoHoldings(accById(targetAccId)).find(h => h.id === holdId) || null) : null;

  function renderResults(list) {
    if (!list || list.length === 0) { dropdown.style.display = 'none'; return; }
    dropdown.innerHTML = list.map(c => `
      <div class="crypto-search-row" data-id="${c.id}" data-symbol="${c.symbol}" data-name="${(c.name||'').replace(/"/g,'&quot;')}" style="display:flex;align-items:center;gap:10px;padding:10px 14px;cursor:pointer;border-bottom:1px solid var(--border);">
        <span style="width:22px;height:22px;flex:none;display:inline-flex;align-items:center;justify-content:center;background:var(--bg-elev-2);border-radius:50%;font-weight:700;font-size:10px;">${(c.symbol||'').slice(0,3)}</span>
        <div style="flex:1;min-width:0;">
          <div style="font-weight:600;">${c.symbol}</div>
          <div style="font-size:11.5px;color:var(--text-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${c.name}</div>
        </div>
        <span style="font-size:11px;color:var(--text-dim);">#${c.rank || '—'}</span>
      </div>
    `).join('');
    dropdown.style.display = 'block';
    dropdown.querySelectorAll('.crypto-search-row').forEach(row => {
      row.onmouseenter = () => row.style.background = 'var(--bg-elev-2)';
      row.onmouseleave = () => row.style.background = '';
      row.onclick = () => {
        selectedCoin = { id: row.dataset.id, symbol: row.dataset.symbol, name: row.dataset.name };
        searchInput.value = selectedCoin.symbol;
        selectedLabel.innerHTML = `выбрано: <strong>${selectedCoin.symbol}</strong> — ${selectedCoin.name}`;
        dropdown.style.display = 'none';
      };
    });
  }

  let searchTimer = null;
  searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim();
    if (searchTimer) clearTimeout(searchTimer);
    if (q.length === 0) { dropdown.style.display = 'none'; return; }
    searchTimer = setTimeout(async () => {
      const results = await searchCryptoLive(q);
      renderResults(results);
    }, 200);
  });
  searchInput.addEventListener('focus', async () => {
    const q = searchInput.value.trim();
    if (q.length >= 1) {
      const results = await searchCryptoLive(q);
      renderResults(results);
    } else {
      const top = await fetchCryptoTopList();
      renderResults(top.slice(0, 30));
    }
  });
  document.addEventListener('click', function clickOutside(e) {
    if (!searchInput.contains(e.target) && !dropdown.contains(e.target)) {
      dropdown.style.display = 'none';
    }
  }, { once: true });

  document.getElementById('crypto-save-btn').onclick = async () => {
    const accountId = document.getElementById('crypto-account').value;
    const acc = accById(accountId);
    if (!acc) { toast('Портфель не найден', 'err'); return; }

    const amount = parseFloat(document.getElementById('crypto-amount').value);
    const buyPriceValue = document.getElementById('crypto-buy-price').value.trim();
    const buyPrice = parseFloat(buyPriceValue);
    const lastPrice = parseFloat(document.getElementById('crypto-last-price').value);
    const searchText = searchInput.value.trim().toUpperCase();

    const ticker = (selectedCoin && selectedCoin.symbol) || searchText;
    if (!ticker || !(amount > 0)) { toast('Выберите монету и укажите количество', 'err'); return; }
    if (!(buyPrice >= 0)) { toast('Укажите цену покупки', 'err'); return; }

    const holdings = getCryptoHoldings(acc);
    const nextHolding = {
      id: holdId || uid(),
      ticker,
      name: (selectedCoin && selectedCoin.name) || ticker,
      coingeckoId: (selectedCoin && selectedCoin.id) || null,
      amount,
      buyPrice: buyPrice || 0,
      buyPriceInput: buyPriceValue,
      lastPrice: lastPrice || null,
      buyDate: document.getElementById('crypto-date').value || todayStr(),
      lastUpdated: new Date().toISOString()
    };
    const nextHoldings = holdId ? holdings.map(h => h.id === holdId ? nextHolding : h) : [...holdings, nextHolding];
    acc.crypto = Object.assign({}, acc.crypto, {
      holdings: nextHoldings,
      network: ticker,
      address: document.getElementById('crypto-address').value.trim(),
      currency: acc.crypto?.currency || acc.currency || state.settings.baseCurrency,
      lastBalance: nextHoldings.reduce((s, h) => s + (h.amount || 0), 0),
      avgBuyPrice: buyPrice || null,
      lastPrice: lastPrice || nextHoldings[0]?.lastPrice || null,
      lastUpdated: new Date().toISOString()
    });

    // списание со счёта при новой позиции
    if (!holdId) {
      const payAccId = (document.getElementById('crypto-payacc') || {}).value;
      if (payAccId && buyPrice > 0) {
        const payAcc = accById(payAccId);
        if (payAcc) {
          const cryptoCur = (acc.crypto && acc.crypto.currency) || state.settings.baseCurrency;
          const accCur = payAcc.currency || state.settings.baseCurrency;
          const totalInAccCur = await convertAmount(amount * buyPrice, cryptoCur, accCur);
          const cat = getPortfolioCategory();
          state.transactions.push({
            id: uid(), type: 'expense', date: todayStr(),
            amount: totalInAccCur, accountId: payAccId, categoryId: cat.id,
            note: 'Покупка ' + ticker, holdingId: nextHolding.id, holdingAccId: accountId
          });
        }
      }
    }

    persist(); closeModal(); renderAll();
    toast('Позиция сохранена', 'ok');
    if (acc.crypto.address) refreshCrypto(acc.id);
  };
}

/* ============================================================
   SELL
   ============================================================ */
function sellStockModal(accId, holdId) {
  const acc = accById(accId);
  if (!acc || acc.type !== 'stocks') return;
  const hold = (acc.holdings || []).find(h => h.id === holdId);
  if (!hold) return;
  const payAccounts = state.accounts.filter(a => a.type === 'cash' || a.type === 'bank');
  if (payAccounts.length === 0) { toast('Нет счетов', 'err'); return; }
  const base = state.settings.baseCurrency;
  const cur = acc.currency || 'USD';
  const opts = payAccounts.map(a => { const acur = a.currency || base; return `<option value="${a.id}">${a.name} — ${fmt(cashAccountBalance(a), acur)}</option>`; }).join('');
  const priceDefault = hold.lastPrice != null ? hold.lastPrice : hold.buyPrice;
  openModal(`
    <h2>Продать ${hold.ticker}</h2>
    <div class="field"><label>В наличии</label><input type="text" value="${hold.shares} шт · по ${fmt(hold.buyPrice, cur)}" disabled></div>
    <div class="field"><label>Количество к продаже</label><input type="number" step="any" id="ss-shares" value="${hold.shares}" max="${hold.shares}"></div>
    <div class="field"><label>Цена за единицу (${cur})</label><input type="number" step="any" id="ss-price" value="${priceDefault}"></div>
    <div class="field"><label>Зачислить на счёт</label><select id="ss-account">${opts}</select></div>
    <div class="modal-actions">
      <button class="btn secondary" onclick="closeModal()">Отмена</button>
      <button class="btn" id="ss-save-btn">Продать</button>
    </div>`);
  document.getElementById('ss-save-btn').onclick = async () => {
    const sharesToSell = parseFloat(document.getElementById('ss-shares').value);
    const price = parseFloat(document.getElementById('ss-price').value);
    const destAccId = document.getElementById('ss-account').value;
    if (!(sharesToSell > 0)) { toast('Укажите количество', 'err'); return; }
    if (sharesToSell > hold.shares) { toast('Больше, чем в наличии', 'err'); return; }
    if (!(price > 0)) { toast('Укажите цену', 'err'); return; }
    const dest = accById(destAccId);
    if (!dest) return;
    const destCur = dest.currency || base;
    const totalDestCur = await convertAmount(sharesToSell * price, cur, destCur);
    const idx = acc.holdings.findIndex(h => h.id === holdId);
    if (idx === -1) return;
    if (sharesToSell >= hold.shares) acc.holdings.splice(idx, 1);
    else acc.holdings[idx].shares -= sharesToSell;
    const cat = getPortfolioCategory();
    state.transactions.push({ id: uid(), type: 'income', date: todayStr(), amount: totalDestCur, accountId: destAccId, categoryId: cat.id, note: 'Продажа ' + hold.ticker });
    persist(); closeModal(); renderAll();
    toast('Продано на ' + fmt(totalDestCur, destCur), 'ok');
  };
}
function sellCryptoModal(accId, holdId) {
  const acc = accById(accId);
  if (!acc || acc.type !== 'crypto') return;
  const list = (acc.crypto && acc.crypto.holdings) || [];
  const hold = list.find(h => h.id === holdId);
  if (!hold) return;
  const payAccounts = state.accounts.filter(a => a.type === 'cash' || a.type === 'bank');
  if (payAccounts.length === 0) { toast('Нет счетов', 'err'); return; }
  const base = state.settings.baseCurrency;
  const cur = (acc.crypto && acc.crypto.currency) || base;
  const opts = payAccounts.map(a => { const acur = a.currency || base; return `<option value="${a.id}">${a.name} — ${fmt(cashAccountBalance(a), acur)}</option>`; }).join('');
  const priceDefault = hold.lastPrice != null ? hold.lastPrice : hold.buyPrice;
  openModal(`
    <h2>Продать ${hold.ticker}</h2>
    <div class="field"><label>В наличии</label><input type="text" value="${hold.amount} ${hold.ticker}" disabled></div>
    <div class="field"><label>Количество к продаже</label><input type="number" step="any" id="sc-amount" value="${hold.amount}" max="${hold.amount}"></div>
    <div class="field"><label>Цена за единицу (${cur})</label><input type="number" step="any" id="sc-price" value="${priceDefault}"></div>
    <div class="field"><label>Зачислить на счёт</label><select id="sc-account">${opts}</select></div>
    <div class="modal-actions">
      <button class="btn secondary" onclick="closeModal()">Отмена</button>
      <button class="btn" id="sc-save-btn">Продать</button>
    </div>`);
  document.getElementById('sc-save-btn').onclick = async () => {
    const amtToSell = parseFloat(document.getElementById('sc-amount').value);
    const price = parseFloat(document.getElementById('sc-price').value);
    const destAccId = document.getElementById('sc-account').value;
    if (!(amtToSell > 0)) { toast('Укажите количество', 'err'); return; }
    if (amtToSell > hold.amount) { toast('Больше, чем в наличии', 'err'); return; }
    if (!(price > 0)) { toast('Укажите цену', 'err'); return; }
    const dest = accById(destAccId);
    if (!dest) return;
    const destCur = dest.currency || base;
    const totalDestCur = await convertAmount(amtToSell * price, cur, destCur);
    const idx = list.findIndex(h => h.id === holdId);
    if (idx === -1) return;
    if (amtToSell >= hold.amount) list.splice(idx, 1);
    else list[idx].amount -= amtToSell;
    acc.crypto.holdings = list;
    acc.crypto.lastBalance = list.reduce((s, h) => s + (h.amount || 0), 0);
    const cat = getPortfolioCategory();
    state.transactions.push({ id: uid(), type: 'income', date: todayStr(), amount: totalDestCur, accountId: destAccId, categoryId: cat.id, note: 'Продажа ' + hold.ticker });
    persist(); closeModal(); renderAll();
    toast('Продано на ' + fmt(totalDestCur, destCur), 'ok');
  };
}

function injectSellButtons() {
  document.querySelectorAll('#stocks-table tr').forEach(tr => {
    if (tr.dataset.sellWired) return;
    const ra = tr.querySelector('.row-actions');
    if (!ra) return;
    const delBtn = ra.querySelector('[onclick*="deleteHolding"]');
    if (!delBtn) return;
    const m = delBtn.getAttribute('onclick').match(/deleteHolding\('([^']+)','([^']+)'\)/);
    if (!m) return;
    const accId = m[1], holdId = m[2].split(',')[0];
    tr.dataset.sellWired = '1';
    const btn = document.createElement('button');
    btn.className = 'icon-btn'; btn.title = 'Продать'; btn.textContent = '−';
    btn.style.color = 'var(--red, #F2545B)'; btn.style.fontWeight = '700';
    btn.onclick = (e) => { e.stopPropagation(); sellStockModal(accId, holdId); };
    ra.insertBefore(btn, ra.firstChild);
  });
  document.querySelectorAll('#crypto-portfolio-list tr').forEach(tr => {
    if (tr.dataset.sellWired) return;
    const ra = tr.querySelector('.row-actions');
    if (!ra) return;
    const delBtn = ra.querySelector('[onclick*="deleteCryptoHolding"]');
    if (!delBtn) return;
    const m = delBtn.getAttribute('onclick').match(/deleteCryptoHolding\('([^']+)','([^']+)'\)/);
    if (!m) return;
    const accId = m[1].split(',')[0], holdId = m[2].split(',')[0];
    tr.dataset.sellWired = '1';
    const btn = document.createElement('button');
    btn.className = 'icon-btn'; btn.title = 'Продать'; btn.textContent = '−';
    btn.style.color = 'var(--red, #F2545B)'; btn.style.fontWeight = '700';
    btn.onclick = (e) => { e.stopPropagation(); sellCryptoModal(accId, holdId); };
    ra.insertBefore(btn, ra.firstChild);
  });
}

function hookPortfolioHooks() {
  if (typeof window.openModal === 'function' && !window.openModal.__portHooked) {
    const orig = window.openModal;
    window.openModal = function (html) {
      const r = orig.apply(this, arguments);
      setTimeout(() => {
        if (document.getElementById('sp-save-btn')) enhanceStockModal();
      }, 50);
      return r;
    };
    window.openModal.__portHooked = true;
  } else if (typeof window.openModal !== 'function') {
    setTimeout(hookPortfolioHooks, 200);
    return;
  }
  if (typeof window.renderAll === 'function' && !window.renderAll.__portHooked) {
    const orig = window.renderAll;
    window.renderAll = function () {
      const r = orig.apply(this, arguments);
      setTimeout(() => {
        injectSellButtons();
        applyTxVisibility();
        try { renderDeposits(); } catch (e) {}
      }, 80);
      return r;
    };
    window.renderAll.__portHooked = true;
  }
}

/* ---------- hooks ---------- */
function hookPersist() {
  if (typeof persist !== 'function') { setTimeout(hookPersist, 200); return; }
  if (persist.__ghHooked) return;
  const orig = persist;
  window.persist = async function (options) {
    const r = await orig.call(this, options || {});
    if (currentUser) { try { saveUserData(currentUser, state); } catch (e) {} }
    if (options && options.skipSync) return r;
    if (options && options.immediate) triggerImmediatePush(options.reason || 'immediate');
    else ghSchedulePush();
    return r;
  };
  window.persist.__ghHooked = true;
}
function hookDeleteTx() {
  if (typeof window.deleteTx !== 'function') { setTimeout(hookDeleteTx, 300); return; }
  if (window.deleteTx.__ghHooked) return;
  const orig = window.deleteTx;
  window.deleteTx = function (id) {
    const r = orig.apply(this, arguments);
    setTimeout(() => triggerImmediatePush('tx-delete'), 150);
    return r;
  };
  window.deleteTx.__ghHooked = true;
}
function hookDeleteHolding() {
  const wrapDelete = (fnName) => {
    if (typeof window[fnName] !== 'function') return false;
    if (window[fnName].__ghHooked) return true;
    const orig = window[fnName];
    window[fnName] = function (accId, holdIdOrIds) {
      const r = orig.apply(this, arguments);
      setTimeout(() => {
        const holdIds = String(holdIdOrIds || '').split(',').map(s => s.trim()).filter(Boolean);
        if (holdIds.length === 0) return;
        const before = state.transactions.length;
        state.transactions = state.transactions.filter(t => !(t.holdingId && holdIds.includes(t.holdingId)));
        const removed = before - state.transactions.length;
        if (removed > 0) {
          persist(); renderAll();
          triggerImmediatePush('holding-delete');
          if (typeof toast === 'function') toast('Удалено транзакций покупки: ' + removed, 'ok');
        }
      }, 100);
      return r;
    };
    window[fnName].__ghHooked = true;
    return true;
  };
  const okA = wrapDelete('deleteHolding');
  const okB = wrapDelete('deleteCryptoHolding');
  if (!okA || !okB) setTimeout(hookDeleteHolding, 400);
}
function setupImmediatePush() {
  if (setupImmediatePush.__wired) return;
  setupImmediatePush.__wired = true;
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    const saveTx     = t.closest('#tx-save-btn');
    const saveAcc    = t.closest('#acc-save-btn');
    const saveCat    = t.closest('#cat-save-btn');
    const saveSub    = t.closest('#sub-save-btn');
    const saveBudget = t.closest('#b-save-btn');
    const saveGoal   = t.closest('#g-save-btn');
    const saveDeposit = t.closest('#d-save-btn');
    const delBtn     = t.closest('[onclick*="deleteTx"]');
    if (!saveTx && !saveAcc && !saveCat && !saveSub && !saveBudget && !saveGoal && !saveDeposit && !delBtn) return;
    setTimeout(() => triggerImmediatePush(saveDeposit ? 'deposit' : (saveTx ? 'tx-save' : (delBtn ? 'tx-delete' : 'data'))), 200);
  }, false);
}

/* ============================================================
   MOBILE MODE
   ============================================================ */
function isMobileDevice() { return /Android|iPhone|iPad|iPod|Opera Mini|IEMobile|WPDesktop/i.test(navigator.userAgent); }
function isMobileMode() { if (!isMobileDevice()) return false; return localStorage.getItem(MOBILE_MODE_KEY) !== 'off'; }
function setMobileMode(on) { localStorage.setItem(MOBILE_MODE_KEY, on ? 'on' : 'off'); applyMobileMode(); }
function injectMobileCSS() {
  if (document.getElementById('mobile-mode-css')) return;
  const style = document.createElement('style');
  style.id = 'mobile-mode-css';
  style.textContent = `
    body.mobile-mode .sidebar { display: none !important; }
    body.mobile-mode .main { padding: 12px 12px 110px; max-width: 100%; }
    body.mobile-mode .view { display: none !important; }
    body.mobile-mode #view-transactions.active { display: block !important; }
    body.mobile-mode #view-settings.active { display: block !important; padding: 12px 12px 100px; }
    body.mobile-mode #view-settings .page-head { padding-right: 56px; }
    body.mobile-mode #view-settings .page-head h1 { font-size: 20px; }
    body.mobile-mode #view-settings .grid.two-col { grid-template-columns: 1fr !important; gap: 12px; }
    body.mobile-mode #view-transactions .page-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; padding-right: 56px; gap: 8px; }
    body.mobile-mode #view-transactions .page-head h1 { font-size: 20px; }
    body.mobile-mode #view-transactions .page-head .sub { display: none; }
    body.mobile-mode #view-transactions #add-tx-btn { display: none !important; }
    body.mobile-mode #view-transactions > .card { background: transparent; border: none; padding: 0; box-shadow: none; }
    body.mobile-mode #tx-empty { padding: 30px 16px; }
    #tx-mobile-list { display: none; }
    .m-tx-day { margin-bottom: 14px; }
    .m-tx-dayhead { display: flex; justify-content: space-between; align-items: center; font-size: 11.5px; font-weight: 700; letter-spacing: .4px; text-transform: uppercase; color: var(--text-dim, #968F80); padding: 0 6px 8px; margin-bottom: 4px; }
    .m-tx-dayhead .pos { color: var(--green, #2FBF71); }
    .m-tx-dayhead .neg { color: var(--red, #F2545B); }
    .m-tx-row { display: grid; grid-template-columns: 1fr auto; grid-template-areas: "cat amt" "meta meta"; gap: 4px 10px; padding: 12px 14px; background: var(--bg-elev, #fff); border: 1px solid var(--border, #EAE2D3); border-radius: 14px; margin-bottom: 6px; cursor: pointer; }
    .m-tx-cat { grid-area: cat; display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 600; color: var(--text, #2B2620); min-width: 0; }
    .m-tx-dot { width: 10px; height: 10px; border-radius: 50%; flex: none; }
    .m-tx-catname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .m-tx-meta { grid-area: meta; display: flex; flex-direction: column; gap: 2px; font-size: 11.5px; color: var(--text-dim, #968F80); min-width: 0; padding-left: 18px; }
    .m-tx-acc { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .m-tx-note { font-style: italic; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: .85; }
    .m-tx-amt { grid-area: amt; font-family: var(--font-mono, monospace); font-weight: 700; font-size: 15px; font-variant-numeric: tabular-nums; white-space: nowrap; align-self: center; }
    .m-tx-amt.pos { color: var(--green, #2FBF71); }
    .m-tx-amt.neg { color: var(--red, #F2545B); }
    .m-tx-amt.tr  { color: var(--text-dim, #968F80); font-weight: 600; }
    #mobile-fab, #mobile-gear { display: none !important; }
    body.mobile-mode #mobile-fab { display: flex !important; position: fixed; right: 18px; bottom: 22px; width: 64px; height: 64px; border-radius: 50%; background: #F4A83D; color: #fff; border: none; font-size: 34px; line-height: 1; font-weight: 300; box-shadow: 0 6px 22px rgba(244,168,61,.5); cursor: pointer; z-index: 9000; align-items: center; justify-content: center; }
    body.mobile-mode #mobile-gear { display: flex !important; position: fixed; right: 14px; top: 12px; width: 44px; height: 44px; border-radius: 50%; background: var(--bg-elev, #fff); color: var(--text-dim, #968F80); border: 1px solid var(--border, #EAE2D3); font-size: 20px; line-height: 1; cursor: pointer; box-shadow: 0 3px 10px rgba(0,0,0,.08); z-index: 9001; align-items: center; justify-content: center; padding: 0; }
    @media (max-width: 760px) {
      .overlay { padding: 10px; align-items: flex-end !important; }
      .modal { max-width: 100% !important; border-radius: 22px 22px 0 0 !important; padding: 22px 18px 26px !important; max-height: 92vh; overflow: auto; }
      .modal h2 { font-size: 18px; margin-bottom: 16px; }
      .field label { font-size: 12px; }
      .field input[type=text],.field input[type=number],.field input[type=date],.field input[type=password],.field select,.field textarea { padding: 14px 14px !important; font-size: 16px !important; border-radius: 14px !important; min-height: 50px; }
      .field-row { flex-direction: column; gap: 12px; }
      .field-row .field { width: 100%; }
      .modal-actions { flex-direction: column-reverse !important; gap: 10px !important; margin-top: 22px !important; position: sticky; bottom: 0; background: var(--bg-elev, #fff); padding-top: 10px; }
      .modal-actions .btn { width: 100% !important; padding: 16px 18px !important; font-size: 15.5px !important; min-height: 54px; border-radius: 14px !important; }
      .icon-btn { min-width: 44px; min-height: 44px; font-size: 18px; }
      .seg { padding: 4px !important; }
      .seg button { padding: 12px 6px !important; font-size: 13px !important; min-height: 44px; }
      .category-option { padding: 12px 14px !important; font-size: 14px !important; min-height: 46px; }
      .btn { min-height: 44px; }
      .btn.small { min-height: 40px; }
    }
  `;
  document.head.appendChild(style);
}
function injectMobileUI() {
  if (!document.getElementById('mobile-fab')) {
    const fab = document.createElement('button');
    fab.id = 'mobile-fab';
    fab.type = 'button';
    fab.textContent = '+';
    fab.onclick = () => { if (typeof openTxModal === 'function') openTxModal(null); };
    document.body.appendChild(fab);
  }
  if (!document.getElementById('mobile-gear')) {
    const gear = document.createElement('button');
    gear.id = 'mobile-gear';
    gear.type = 'button';
    gear.textContent = '⚙';
    gear.onclick = () => {
      const settingsActive = document.getElementById('view-settings').classList.contains('active');
      if (settingsActive) { if (typeof showView === 'function') showView('transactions'); }
      else { if (typeof showView === 'function') showView('settings'); }
      setTimeout(updateMobileChrome, 30);
    };
    document.body.appendChild(gear);
  }
}
function updateMobileChrome() {
  const gear = document.getElementById('mobile-gear');
  if (!gear) return;
  const settingsActive = document.getElementById('view-settings').classList.contains('active');
  gear.textContent = settingsActive ? '←' : '⚙';
}
function applyMobileMode() {
  injectMobileCSS();
  injectMobileUI();
  const on = isMobileMode();
  document.body.classList.toggle('mobile-mode', on);
  if (on) {
    const settingsActive = document.getElementById('view-settings').classList.contains('active');
    if (!settingsActive) {
      const txActive = document.getElementById('view-transactions').classList.contains('active');
      if (!txActive && typeof showView === 'function') showView('transactions');
    }
  }
  updateMobileChrome();
  applyTxVisibility();
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
        <div style="margin-bottom:12px;"><label style="display:block;font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:var(--text-dim,#968F80);margin-bottom:6px;font-weight:600;">Логин</label>
          <input type="text" id="li-login" autocomplete="username" style="width:100%;background:var(--bg-elev-2,#F2EDE3);border:1px solid var(--border,#EAE2D3);color:var(--text,#2B2620);padding:11px 14px;border-radius:12px;font-size:16px;box-sizing:border-box;"></div>
        <div style="margin-bottom:16px;"><label style="display:block;font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:var(--text-dim,#968F80);margin-bottom:6px;font-weight:600;">Пароль</label>
          <input type="password" id="li-pass" autocomplete="current-password" style="width:100%;background:var(--bg-elev-2,#F2EDE3);border:1px solid var(--border,#EAE2D3);color:var(--text,#2B2620);padding:11px 14px;border-radius:12px;font-size:16px;box-sizing:border-box;"></div>
        <button id="li-submit" style="width:100%;background:#F4A83D;color:#fff;border:none;padding:14px 18px;border-radius:13px;font-weight:600;font-size:14.5px;cursor:pointer;min-height:50px;">Войти</button>
        <button id="li-bootstrap" style="width:100%;background:transparent;color:#F4A83D;border:1px solid #F4A83D;padding:13px 18px;border-radius:13px;font-weight:600;font-size:13px;cursor:pointer;margin-top:10px;min-height:48px;">Войти с другого устройства</button>
      </div>
      <div id="auth-register-form">
        <div style="margin-bottom:12px;"><label style="display:block;font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:var(--text-dim,#968F80);margin-bottom:6px;font-weight:600;">Логин</label>
          <input type="text" id="rg-login" autocomplete="username" style="width:100%;background:var(--bg-elev-2,#F2EDE3);border:1px solid var(--border,#EAE2D3);color:var(--text,#2B2620);padding:11px 14px;border-radius:12px;font-size:16px;box-sizing:border-box;"></div>
        <div style="margin-bottom:12px;"><label style="display:block;font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:var(--text-dim,#968F80);margin-bottom:6px;font-weight:600;">Пароль</label>
          <input type="password" id="rg-pass" autocomplete="new-password" style="width:100%;background:var(--bg-elev-2,#F2EDE3);border:1px solid var(--border,#EAE2D3);color:var(--text,#2B2620);padding:11px 14px;border-radius:12px;font-size:16px;box-sizing:border-box;"></div>
        <div style="margin-bottom:16px;"><label style="display:block;font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:var(--text-dim,#968F80);margin-bottom:6px;font-weight:600;">Повтор пароля</label>
          <input type="password" id="rg-pass2" autocomplete="new-password" style="width:100%;background:var(--bg-elev-2,#F2EDE3);border:1px solid var(--border,#EAE2D3);color:var(--text,#2B2620);padding:11px 14px;border-radius:12px;font-size:16px;box-sizing:border-box;"></div>
        <button id="rg-submit" style="width:100%;background:#F4A83D;color:#fff;border:none;padding:14px 18px;border-radius:13px;font-weight:600;font-size:14.5px;cursor:pointer;min-height:50px;">Создать аккаунт</button>
      </div>
      <div id="auth-err" style="color:#F2545B;font-size:12.5px;margin-top:12px;text-align:center;min-height:16px;"></div>
    </div>
    <div id="bootstrap-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:100000;align-items:center;justify-content:center;padding:20px;">
      <div style="background:var(--bg-elev,#fff);border-radius:22px;padding:26px;width:100%;max-width:380px;box-shadow:0 6px 20px rgba(43,38,32,.15);">
        <h2 style="font-family:'Poppins','Segoe UI',sans-serif;font-size:19px;font-weight:700;margin-bottom:14px;color:var(--text,#2B2620);">Подключение с другого устройства</h2>
        <p style="font-size:12.5px;color:var(--text-dim,#968F80);line-height:1.5;margin-bottom:14px;">Введите те же настройки GitHub, что и на первом устройстве.</p>
        <div style="margin-bottom:10px;"><label style="font-size:11px;text-transform:uppercase;color:var(--text-dim,#968F80);font-weight:600;">GitHub username</label>
          <input type="text" id="bs-user" style="width:100%;background:var(--bg-elev-2,#F2EDE3);border:1px solid var(--border,#EAE2D3);color:var(--text,#2B2620);padding:12px 12px;border-radius:12px;font-size:16px;margin-top:4px;box-sizing:border-box;"></div>
        <div style="margin-bottom:10px;"><label style="font-size:11px;text-transform:uppercase;color:var(--text-dim,#968F80);font-weight:600;">Репозиторий</label>
          <input type="text" id="bs-repo" value="budget-data" style="width:100%;background:var(--bg-elev-2,#F2EDE3);border:1px solid var(--border,#EAE2D3);color:var(--text,#2B2620);padding:12px 12px;border-radius:12px;font-size:16px;margin-top:4px;box-sizing:border-box;"></div>
        <div style="margin-bottom:10px;"><label style="font-size:11px;text-transform:uppercase;color:var(--text-dim,#968F80);font-weight:600;">Ветка</label>
          <input type="text" id="bs-branch" value="main" style="width:100%;background:var(--bg-elev-2,#F2EDE3);border:1px solid var(--border,#EAE2D3);color:var(--text,#2B2620);padding:12px 12px;border-radius:12px;font-size:16px;margin-top:4px;box-sizing:border-box;"></div>
        <div style="margin-bottom:16px;"><label style="font-size:11px;text-transform:uppercase;color:var(--text-dim,#968F80);font-weight:600;">Token</label>
          <input type="password" id="bs-token" placeholder="github_pat_..." style="width:100%;background:var(--bg-elev-2,#F2EDE3);border:1px solid var(--border,#EAE2D3);color:var(--text,#2B2620);padding:12px 12px;border-radius:12px;font-size:16px;margin-top:4px;box-sizing:border-box;"></div>
        <div id="bs-err" style="color:#F2545B;font-size:12.5px;margin-bottom:10px;min-height:14px;"></div>
        <div style="display:flex;gap:8px;flex-direction:column-reverse;">
          <button id="bs-cancel" style="background:var(--bg-elev-2,#F2EDE3);color:var(--text,#2B2620);border:1px solid var(--border,#EAE2D3);padding:14px 16px;border-radius:12px;font-weight:600;font-size:14px;cursor:pointer;width:100%;min-height:50px;">Отмена</button>
          <button id="bs-go" style="background:#F4A83D;color:#fff;border:none;padding:14px 16px;border-radius:12px;font-weight:600;font-size:14px;cursor:pointer;width:100%;min-height:50px;">Подключить</button>
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
function showAuth() { injectAuth(); const el = document.getElementById('auth-screen'); if (el) el.style.display = 'flex'; }
function hideAuth() { const el = document.getElementById('auth-screen'); if (el) el.style.display = 'none'; }
function setAuthTab(tab) {
  const lt = document.getElementById('auth-tab-login');
  const rt = document.getElementById('auth-tab-register');
  const lf = document.getElementById('auth-login-form');
  const rf = document.getElementById('auth-register-form');
  const err = document.getElementById('auth-err');
  err.textContent = '';
  const on = 'background:#F4A83D;color:#fff;border-radius:11px;margin:2px;';
  const off = 'background:transparent;color:var(--text-dim,#968F80);margin:0;';
  if (tab === 'login') {
    lt.style.cssText += ';' + on; rt.style.cssText += ';' + off;
    lf.style.display = 'block'; rf.style.display = 'none';
    setTimeout(() => document.getElementById('li-login').focus(), 50);
  } else {
    rt.style.cssText += ';' + on; lt.style.cssText += ';' + off;
    rf.style.display = 'block'; lf.style.display = 'none';
    setTimeout(() => document.getElementById('rg-login').focus(), 50);
  }
}
function wireAuth() {
  document.getElementById('auth-tab-login').onclick = () => setAuthTab('login');
  document.getElementById('auth-tab-register').onclick = () => setAuthTab('register');
  const doLogin = async () => {
    const login = (document.getElementById('li-login').value || '').trim().toLowerCase();
    const pass = document.getElementById('li-pass').value || '';
    const err = document.getElementById('auth-err');
    err.textContent = '';
    if (!login || !pass) { err.textContent = 'Заполните логин и пароль'; return; }
    const accs = accounts();
    if (!accs[login]) { err.textContent = 'Аккаунт не найден.'; return; }
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
  document.getElementById('bs-cancel').onclick = () => { document.getElementById('bootstrap-modal').style.display = 'none'; };
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
    if (!remote || Object.keys(remote).length === 0) { err.textContent = 'Не удалось загрузить accounts.json.'; return; }
    const merged = Object.assign({}, remote, accounts());
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
function enterAccount(login) {
  currentUser = login;
  saveSession({ login, createdAt: new Date().toISOString() });
  const pending = pendingGh();
  if (pending) { ghSaveCfg(pending, login); setPendingGh(null); }
  const udata = loadUserData(login);
  if (udata) localStorage.setItem(STORAGE_KEY, JSON.stringify(udata));
  else { try { const fresh = defaultState(); localStorage.setItem(STORAGE_KEY, JSON.stringify(fresh)); saveUserData(login, fresh); } catch (e) {} }
  setLoadedUser(login);
  location.reload();
}
function logout() {
  if (!confirm('Выйти из аккаунта?')) return;
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
    <p style="font-size:12.5px;color:var(--text-dim);line-height:1.6;margin-bottom:14px;">Аккаунт: <strong>${currentUser || '—'}</strong>. Токен хранится только в этом браузере.</p>
    <div class="field-row">
      <div class="field"><label>GitHub username</label><input type="text" id="gh-user" value="${cfg.user || ''}"></div>
      <div class="field"><label>Репозиторий</label><input type="text" id="gh-repo" value="${cfg.repo || 'budget-data'}"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Ветка</label><input type="text" id="gh-branch" value="${cfg.branch || 'main'}"></div>
      <div class="field"><label>Файл данных</label><input type="text" id="gh-path" value="${cfg.path || 'data.json'}"></div>
    </div>
    <div class="field"><label>Personal Access Token</label><input type="password" id="gh-token" value="${cfg.token || ''}"></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;">
      <button class="btn small" id="gh-save">Сохранить</button>
      <button class="btn secondary small" id="gh-push">Отправить</button>
      <button class="btn secondary small" id="gh-pull">Загрузить</button>
      <button class="btn danger small" id="gh-logout" style="margin-left:auto;">Выйти</button>
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
    ghSaveCfg(c); ghSha = null;
    toast('Настройки сохранены', 'ok');
    await pushAccountsFile();
    await ghPullAndMerge();
    ghUpdateStatus();
  };
  document.getElementById('gh-push').onclick = async () => { await pushAccountsFile(); ghPushNow('manual'); };
  document.getElementById('gh-pull').onclick = async () => { await ghPullAndMerge(); ghUpdateStatus(); };
  document.getElementById('gh-logout').onclick = logout;
  ghUpdateStatus();
}
function ghUpdateStatus() {
  const el = document.getElementById('gh-status');
  if (!el) return;
  const c = ghCfg();
  if (!c.token || !c.user || !c.repo) el.textContent = 'Не настроено.';
  else el.textContent = 'Последняя синхронизация: ' + (c.lastSync || '—');
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
    if (udata) localStorage.setItem(STORAGE_KEY, JSON.stringify(udata));
    else { try { saveUserData(s.login, state); } catch (e) {} }
    setLoadedUser(s.login);
    location.reload();
    return;
  }

  hideAuth();
  hookPersist();
  hookDeleteTx();
  hookDeleteHolding();
  setupImmediatePush();
  hookPortfolioHooks();
  hookFxGlobals();

  // Ждём появления DOM от index.html и инжектим свои элементы
  setTimeout(() => {
    injectDepositsNav();
    injectDepositsView();
  }, 150);

  try { window.renderAccounts = renderAccountsNative; } catch (e) {}
  try { window.renderTransactions = renderTransactionsCombined; } catch (e) {}
  try { window.renderGoals = renderGoalsNative; } catch (e) {}
  try { window.addGoalFunds = addGoalFundsModal; } catch (e) {}
  try { window.withdrawGoalFunds = withdrawGoalFundsModal; } catch (e) {}
  try { window.openGoalModal = openGoalModalNative; } catch (e) {}
  try { window.editGoal = function(id){ openGoalModalNative(state.goals.find(g => g.id === id)); }; } catch (e) {}

  // Подменяем форму крипты на свою (с живым поиском)
  try { window.openCryptoHoldingModal = openCryptoHoldingModalNew; } catch (e) {}

  // Встраиваем наш рендер вкладок в renderAll (в дополнение к portfolio hook)
  try {
    const base = window.renderAll;
    if (base && !base.__depHook) {
      window.renderAll = function () {
        const r = base.apply(this, arguments);
        setTimeout(() => { try { renderDeposits(); } catch (e) {} }, 60);
        return r;
      };
      window.renderAll.__depHook = true;
    }
  } catch (e) {}

  if (typeof renderAll === 'function') { try { renderAll(); } catch (e) {} }

  const tryMobile = () => {
    if (!isMobileMode()) { applyMobileMode(); return; }
    if (typeof showView === 'function') {
      const settingsActive = document.getElementById('view-settings').classList.contains('active');
      if (!settingsActive) showView('transactions');
    }
    applyMobileMode();
  };
  setTimeout(tryMobile, 200);
  setTimeout(tryMobile, 600);
  setTimeout(tryMobile, 1500);

  setTimeout(injectGithubCard, 400);
  setInterval(() => {
    if (!document.getElementById('gh-sync-card')) injectGithubCard();
  }, 1500);

  if (typeof window.showView === 'function' && !window.showView.__ghHooked) {
    const origShow = window.showView;
    window.showView = function (id) {
      // В мобильном режиме разрешаем только transactions и settings
      if (isMobileMode() && id !== 'settings' && id !== 'transactions') id = 'transactions';
      // Если целевой view не существует — игнорируем (например, deposits удалён)
      const targetView = document.getElementById('view-' + id);
      if (!targetView) return;
      origShow.call(this, id);
      if (isMobileMode()) {
        document.querySelectorAll('.view').forEach(v => { if (v.id !== 'view-' + id) v.classList.remove('active'); });
        targetView.classList.add('active');
      }
      setTimeout(() => {
        updateMobileChrome();
        applyTxVisibility();
        // Если перешли во вклады — отрисовать
        if (id === 'deposits') renderDeposits();
      }, 30);
    };
    window.showView.__ghHooked = true;
  }

  // FX
  setTimeout(async () => { await refreshAllFxRates(false); if (typeof renderAll === 'function') renderAll(); }, 700);
  startFxAutoRefresh();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshAllFxRates(false).then(() => { if (typeof renderAll === 'function') renderAll(); });
  });

  const c = ghCfg();
  if (c.token && c.user && c.repo) {
    setTimeout(ghPullAndMerge, 900);
    setInterval(() => { if (document.visibilityState === 'visible') ghPullAndMerge(); }, 120000);
  }

  window.addEventListener('resize', applyMobileMode);
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
  mobile: {
    state: isMobileMode,
    off: () => setMobileMode(false),
    on: () => setMobileMode(true),
    refresh: applyMobileMode
  },
  fx: {
    refresh: () => refreshAllFxRates(true).then(r => { renderAll(); return r; }),
    convert: convertAmount,
    cache: loadFxCache,
    clearCache: () => { localStorage.removeItem(FX_CACHE_KEY); }
  },
  crypto: {
    search: searchCryptoLive,
    top: fetchCryptoTopList,
    openModal: openCryptoHoldingModalNew
  },
  deposits: {
    open: openDepositModal,
    close: closeDeposit,
    calc: calcDeposit,
    list: depositsList
  },
  goals: {
    add: addGoalFundsModal,
    withdraw: withdrawGoalFundsModal,
    balance: computeGoalBalance
  },
  portfolio: {
    sellStock: sellStockModal,
    sellCrypto: sellCryptoModal
  }
};

/* === ЭТИ СТРОКИ ДОБАВЬ === */
try { window.openDepositModal = openDepositModal; } catch (e) {}
try { window.closeDeposit = closeDeposit; } catch (e) {}
try { window.calcDeposit = calcDeposit; } catch (e) {}
try { window.renderDeposits = renderDeposits; } catch (e) {}
try { window.depositsList = depositsList; } catch (e) {}
try { window.openCryptoHoldingModalNew = openCryptoHoldingModalNew; } catch (e) {}
try { window.searchCryptoLive = searchCryptoLive; } catch (e) {}
try { window.fetchCryptoTopList = fetchCryptoTopList; } catch (e) {}

})();
