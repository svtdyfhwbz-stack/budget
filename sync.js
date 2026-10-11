async function ghPush(message) {
  const cfg = ghCfg();
  if (!cfg.token || !cfg.user || !cfg.repo) return false;
  const path = cfg.path || 'data.json';
  const branch = cfg.branch || 'main';

  state.lastModified = new Date().toISOString();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  saveUserData(currentUser, state);

  for (let attempt = 0; attempt < 3; attempt++) {
    // 1. всегда забираем свежий SHA с сервера — никакого кэша
    let serverSha = null;
    let serverData = null;
    try {
      const j = await ghFetch('GET',
        `/repos/${cfg.user}/${cfg.repo}/contents/${path}?ref=${branch}`);
      if (j && j.content) {
        serverSha = j.sha;
        try { serverData = JSON.parse(b64ToUtf8(j.content)); } catch (e) {}
      }
    } catch (e) { /* файл ещё не создан */ }

    // 2. если на сервере свежее — подтягиваем, а не перезаписываем
    if (serverData) {
      const rt = new Date(serverData.lastModified || 0).getTime();
      const lt = new Date(state.lastModified || 0).getTime();
      if (rt > lt + 2000) {
        state = Object.assign(defaultState(), serverData);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        saveUserData(currentUser, state);
        if (typeof renderAll === 'function') renderAll();
        if (typeof toast === 'function') toast('Данные с сервера свежее — загружены', 'ok');
        return false;
      }
    }

    // 3. PUT с актуальным SHA
    const content = utf8ToB64(JSON.stringify(state, null, 2));
    const body = { message: message || ('sync ' + new Date().toISOString()), content, branch };
    if (serverSha) body.sha = serverSha;

    try {
      const r = await ghFetch('PUT',
        `/repos/${cfg.user}/${cfg.repo}/contents/${path}`, body);
      if (r && r.content) {
        ghSha = r.content.sha;
        cfg.lastSync = new Date().toLocaleString('ru-RU');
        ghSaveCfg(cfg);
        return true;
      }
    } catch (e) {
      const msg = String((e && e.message) || '');
      if (msg.includes('409') || msg.includes('does not match')) {
        console.warn('409 retry', attempt);
        await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
        continue;
      }
      throw e;
    }
  }
  console.warn('gh push: max retries');
  return false;
}
