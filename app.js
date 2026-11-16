(() => {
  'use strict';

  // --- Global State ---
  const state = {
    catalog: null,
    maps: {},
    savesDir: '',
    savesList: [],
    currentPath: '',
    currentName: '',
    format: 'compressed',
    rawJsonText: '',
    originalJsonStr: '',
    data: null,
    undoStack: [],
    redoStack: [],
    activeTab: 'overview',
    // Flow studio state
    activeFlowIndex: 0,
    selectedKind: null, // 'element' | 'pipe' | 'deco' | null
    selectedIndex: -1,
    selectedElements: [], // multi-select element indices
    selectedPipeNode: -1,
    flowTool: 'select', // 'select' | 'connect' | 'box'
    connectStart: null, // { elIndex, outIndex }
    gridSnap: 64,
    snapGuides: [],
    boxSelect: null, // { x0, y0, x1, y1 } in screen px
    cam: { x: 0, y: 0, zoom: 0.75 },
    // Cleaner options
    cleanerOpts: {
      warKeep: 20,
      ioKeep: 5,
      stockpileKeep: 20,
      armoryKeep: 10,
    },
    // UI filters
    techSearch: '',
    techFilter: 'all', // 'all' | 'unlocked' | 'locked' | 'modded'
    techBranch: 'all',
    rawSearch: '',
    farmBrush: 'cattle',
    armoryChannel: 0,
    savesFilter: '',
  };

  // --- Utilities ---
  const $ = (id) => document.getElementById(id);

  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function toast(msg, kind = 'info') {
    const c = $('toast-container');
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = msg;
    c.appendChild(el);
    setTimeout(() => el.remove(), 3800);
  }

  function spriteUrl(iconName) {
    if (!iconName) return '/sprites/Icons_1.png';
    return `/sprites/${encodeURIComponent(iconName)}.png`;
  }

  function spriteImg(iconName, size = 20, extraClass = '') {
    if (!iconName) return '';
    return `<img class="sprite ${extraClass}" src="${spriteUrl(iconName)}" style="width:${size}px;height:${size}px;" loading="lazy" onerror="this.style.visibility='hidden'" alt="" />`;
  }

  function formatDuration(sec) {
    sec = Math.max(0, Math.floor(Number(sec) || 0));
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const hms = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return d > 0 ? `${d}d ${hms}` : hms;
  }

  function formatBytes(b) {
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${(b / (1024 * 1024)).toFixed(2)} MB`;
  }

  function formatNum(n) {
    const num = Number(n);
    if (!Number.isFinite(num)) return String(n);
    if (Math.abs(num) >= 1e9) return (num / 1e9).toFixed(2) + 'B';
    if (Math.abs(num) >= 1e6) return (num / 1e6).toFixed(2) + 'M';
    if (Math.abs(num) >= 1e4) return (num / 1e3).toFixed(1) + 'K';
    return num.toLocaleString();
  }

  async function api(url, method = 'GET', body = null) {
    const opts = { method, headers: {} };
    if (body !== null) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    const json = await res.json();
    if (!res.ok || json.error) {
      throw new Error(json.error || `HTTP ${res.status}`);
    }
    return json;
  }

  // --- Item String / Object Helpers (matches InventoryItem.cs) ---
  function parseTypeString(typeStr) {
    const str = String(typeStr || '');
    const parts = str.split(':');
    const out = { id: parts[0], quality: 1.0, seed: '' };
    for (let i = 1; i < parts.length; i++) {
      const p = parts[i];
      if (!p) continue;
      if (p[0] === 'q') {
        const q = parseInt(p.slice(1), 10);
        if (!Number.isNaN(q)) out.quality = q / 1000;
      } else if (p[0] === 's') {
        out.seed = p.slice(1);
      }
    }
    return out;
  }

  function buildTypeString(id, quality, seed) {
    let s = id || 'iron_ore';
    const q = Number(quality);
    if (Number.isFinite(q) && Math.abs(q - 1.0) >= 0.001) {
      s += `:q${Math.round(q * 1000)}`;
    }
    if (seed) {
      s += `:s${seed}`;
    }
    return s;
  }

  function getItemSummary(item) {
    if (!item) return { id: '', name: '(Empty)', icon: '', quality: 1, isObj: false };
    const isObj = typeof item === 'object';
    const typeStr = isObj ? item.Type : item;
    const parsed = parseTypeString(typeStr);
    const cat = state.maps.items[parsed.id] || state.maps.adventurers[parsed.id];
    const name = cat ? cat.Name : parsed.id;
    const icon = cat ? cat.Icon : 'Icons_11';
    return {
      id: parsed.id,
      name,
      icon,
      quality: parsed.quality,
      seed: parsed.seed,
      isObj,
      cat,
    };
  }

  function randomSeed(len = 9) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let s = '';
    for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }

  // --- History & Dirty Tracking ---
  function isDirty() {
    if (!state.data) return false;
    return JSON.stringify(state.data) !== state.originalJsonStr;
  }

  function commitChange(label, mutator, rerender = true) {
    if (!state.data) return;
    const before = JSON.stringify(state.data);
    mutator(state.data);
    const after = JSON.stringify(state.data);
    if (before === after) return;
    state.undoStack.push({ label, snapshot: before });
    if (state.undoStack.length > 80) state.undoStack.shift();
    state.redoStack.length = 0;
    updateTopbarState();
    if (rerender) renderActiveTab();
  }

  function undo() {
    if (!state.undoStack.length) return;
    const entry = state.undoStack.pop();
    state.redoStack.push({ label: entry.label, snapshot: JSON.stringify(state.data) });
    state.data = JSON.parse(entry.snapshot);
    updateTopbarState();
    renderActiveTab();
    toast(`Undid: ${entry.label}`, 'info');
  }

  function redo() {
    if (!state.redoStack.length) return;
    const entry = state.redoStack.pop();
    state.undoStack.push({ label: entry.label, snapshot: JSON.stringify(state.data) });
    state.data = JSON.parse(entry.snapshot);
    updateTopbarState();
    renderActiveTab();
    toast(`Redid: ${entry.label}`, 'info');
  }

  function updateTopbarState() {
    const hasSave = !!state.data;
    $('btn-undo').disabled = state.undoStack.length === 0;
    $('btn-redo').disabled = state.redoStack.length === 0;
    $('btn-scan-bloat').disabled = !hasSave;
    $('btn-diff').disabled = !hasSave;
    $('btn-backups').disabled = !state.currentPath;
    $('btn-export').disabled = !hasSave;
    $('btn-save-as').disabled = !hasSave;
    $('btn-save').disabled = !hasSave || !state.currentPath;

    if (hasSave) {
      $('active-save-name').textContent = state.currentName || 'Unsaved';
      $('active-save-version').textContent = state.data.Version || 'Unknown';
      $('active-save-format').textContent = state.format;
      $('dirty-badge').style.display = isDirty() ? 'inline-flex' : 'none';
    } else {
      $('active-save-name').textContent = 'No save loaded';
      $('active-save-version').textContent = '—';
      $('active-save-format').textContent = '—';
      $('dirty-badge').style.display = 'none';
    }
  }

  // --- Catalog Indexing ---
  function buildCatalogMaps(cat) {
    const byId = (arr) => {
      const m = {};
      for (const x of arr || []) m[x.Id || x.id] = x;
      return m;
    };
    state.maps = {
      techs: byId(cat.techs),
      elements: byId(cat.elements),
      items: byId(cat.items),
      adventurers: byId(cat.adventurers),
      allItems: { ...byId(cat.items), ...byId(cat.adventurers) },
      recipes: byId(cat.recipes),
      currencies: byId(cat.currencies),
      quests: byId(cat.quests),
      dungeons: byId(cat.dungeons),
      wars: byId(cat.wars),
      prestige: byId(cat.prestigeNodes),
      upgrades: byId(cat.flowUpgrades),
      enhancements: byId(cat.enhancements),
    };
  }

  // --- Save Loading & Writing ---
  async function refreshSavesList() {
    const dir = $('saves-dir-input').value.trim();
    const q = dir ? `?dir=${encodeURIComponent(dir)}` : '';
    const res = await api(`/api/saves${q}`);
    state.savesDir = res.savesDir;
    $('saves-dir-input').value = res.savesDir;
    state.savesList = res.saves || [];
    renderSavesList();
  }

  function renderSavesList() {
    const list = $('saves-list');
    const filter = state.savesFilter.toLowerCase();
    const items = state.savesList.filter((s) => !filter || s.name.toLowerCase().includes(filter));
    if (!items.length) {
      list.innerHTML = `<div style="padding:16px;color:var(--text-muted);text-align:center;">No saves found in directory.</div>`;
      return;
    }
    list.innerHTML = items.map((s) => {
      const active = s.path === state.currentPath ? 'active' : '';
      return `
        <div class="save-item ${active}" data-path="${esc(s.path)}">
          <div class="save-item-title">
            <span>${esc(s.name)}</span>
            <span class="badge ${s.format === 'compressed' ? 'accent' : 'gold'}">${esc(s.format)}</span>
          </div>
          <div class="save-item-meta">
            <span>${esc(s.version || '?')}</span>
            <span>⏱ ${formatDuration(s.gameTime)}</span>
            <span>★ Asc ${s.ascensionCount || 0}</span>
            <span>⚡ ${s.flowCount} flows</span>
          </div>
          <div class="save-item-meta">
            <span>${esc(s.mtimeIso)}</span>
            <span>${formatBytes(s.size)}</span>
          </div>
          ${s.error ? `<div style="color:var(--red);font-size:10.5px;">${esc(s.error)}</div>` : ''}
        </div>
      `;
    }).join('');
    list.querySelectorAll('.save-item').forEach((el) => {
      el.addEventListener('click', () => loadSaveByPath(el.dataset.path));
    });
  }

  async function loadSaveByPath(path) {
    if (isDirty() && !confirm('You have unsaved changes. Load another save anyway?')) return;
    try {
      const res = await api('/api/save/load', 'POST', { path });
      applyLoadedSave(res);
      toast(`Loaded ${res.name} (${formatBytes(res.rawBytes)})`, 'ok');
    } catch (err) {
      toast(`Failed to load save: ${err.message}`, 'err');
    }
  }

  function applyLoadedSave(res) {
    state.currentPath = res.path || '';
    state.currentName = res.name || 'save.save';
    state.format = res.format || 'compressed';
    state.data = res.data;
    state.originalJsonStr = JSON.stringify(res.data);
    state.undoStack = [];
    state.redoStack = [];
    state.activeFlowIndex = Math.min(res.data?.Player?.CurrentFlow || 0, Math.max(0, (res.data?.Player?.Flows?.length || 1) - 1));
    state.selectedKind = null;
    state.selectedIndex = -1;
    $('save-format-select').value = state.format === 'pretty' ? 'pretty' : state.format === 'uncompressed' ? 'uncompressed' : 'compressed';
    $('secret-mode-select').value = 'Secret' in res.data ? 'keep' : 'remove';
    renderSavesList();
    updateTopbarState();
    fitFlowCamera();
    renderActiveTab();
  }

  async function saveCurrentFile() {
    if (!state.data || !state.currentPath) return;
    try {
      const fmt = $('save-format-select').value;
      const secretMode = $('secret-mode-select').value;
      const res = await api('/api/save/write', 'POST', {
        path: state.currentPath,
        data: state.data,
        format: fmt,
        secretMode,
        createBackup: true,
      });
      state.format = fmt;
      state.originalJsonStr = JSON.stringify(state.data);
      updateTopbarState();
      refreshSavesList();
      toast(`Saved ${state.currentName} (${formatBytes(res.bytesWritten)}). Backup created.`, 'ok');
    } catch (err) {
      toast(`Save failed: ${err.message}`, 'err');
    }
  }

  async function saveAsFile() {
    if (!state.data) return;
    const defaultName = state.currentName ? state.currentName.replace(/\.(save|json)$/i, '_edited.save') : 'edited.save';
    const name = prompt('Enter new save filename (stored in Saves directory):', defaultName);
    if (!name) return;
    try {
      const fmt = $('save-format-select').value;
      const secretMode = $('secret-mode-select').value;
      const res = await api('/api/save/save-as', 'POST', {
        name,
        dir: state.savesDir,
        data: state.data,
        format: fmt,
        secretMode,
      });
      state.currentPath = res.path;
      state.currentName = res.path.split(/[\\/]/).pop();
      state.format = fmt;
      state.originalJsonStr = JSON.stringify(state.data);
      updateTopbarState();
      await refreshSavesList();
      toast(`Saved As ${state.currentName}`, 'ok');
    } catch (err) {
      toast(`Save As failed: ${err.message}`, 'err');
    }
  }

  async function exportCurrentSave() {
    if (!state.data) return;
    try {
      const fmt = $('save-format-select').value;
      const secretMode = $('secret-mode-select').value;
      const res = await api('/api/save/export', 'POST', {
        data: state.data,
        format: fmt,
        secretMode,
      });
      const bytes = Uint8Array.from(atob(res.contentBase64), (c) => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: 'application/octet-stream' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      const ext = fmt === 'compressed' ? '.save' : '.json';
      a.download = (state.currentName || 'kingdom_save').replace(/\.(save|json)$/i, '') + ext;
      a.click();
      URL.revokeObjectURL(a.href);
      toast(`Exported ${a.download} (${formatBytes(res.bytes)})`, 'ok');
    } catch (err) {
      toast(`Export failed: ${err.message}`, 'err');
    }
  }

  async function handleFileUpload(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const bytes = new Uint8Array(reader.result);
        let bin = '';
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        const res = await api('/api/save/upload', 'POST', {
          name: file.name,
          contentBase64: btoa(bin),
        });
        applyLoadedSave(res);
        toast(`Opened ${file.name} (read-only upload; use Save As to store in Saves dir)`, 'warn');
      } catch (err) {
        toast(`Failed to parse file: ${err.message}`, 'err');
      }
    };
    reader.readAsArrayBuffer(file);
  }

  // --- Modal Helpers ---
  function openModal(title, bodyHtml, footerButtons = [], wide = false) {
    $('modal-title').innerHTML = title;
    $('modal-body').innerHTML = bodyHtml;
    const box = $('modal-box');
    box.classList.toggle('wide', wide);
    const footer = $('modal-footer');
    footer.innerHTML = '';
    for (const btn of footerButtons) {
      const b = document.createElement('button');
      b.textContent = btn.label;
      b.className = btn.className || '';
      b.addEventListener('click', () => btn.onClick && btn.onClick());
      footer.appendChild(b);
    }
    $('modal-backdrop').classList.add('open');
  }

  function closeModal() {
    $('modal-backdrop').classList.remove('open');
  }

  // --- Catalog Picker Modal ---
  function openCatalogPicker({ title, entries, showNone = false, onSelect }) {
    let query = '';
    const renderList = () => {
      const q = query.toLowerCase();
      const filtered = entries.filter((e) =>
        !q || (e.name || '').toLowerCase().includes(q) || (e.id || '').toLowerCase().includes(q) || (e.sub || '').toLowerCase().includes(q)
      ).slice(0, 180);
      const grid = $('picker-grid');
      if (!grid) return;
      grid.innerHTML = (showNone ? `
        <div class="tech-card" data-pick="">
          <div class="tech-info"><div class="tech-name">(None / Clear)</div></div>
        </div>` : '') +
        filtered.map((e) => `
          <div class="tech-card" data-pick="${esc(e.id)}">
            ${spriteImg(e.icon, 26)}
            <div class="tech-info">
              <div class="tech-name">${esc(e.name)}</div>
              <div class="tech-id">${esc(e.id)}${e.sub ? ' · ' + esc(e.sub) : ''}</div>
            </div>
          </div>
        `).join('');
      grid.querySelectorAll('[data-pick]').forEach((el) => {
        el.addEventListener('click', () => {
          closeModal();
          onSelect(el.dataset.pick || null);
        });
      });
    };
    openModal(
      esc(title),
      `
        <div class="row">
          <input type="text" id="picker-search" placeholder="Search by name or ID..." style="flex:1;" autofocus />
        </div>
        <div class="tech-grid" id="picker-grid" style="max-height:55vh;overflow-y:auto;"></div>
      `,
      [{ label: 'Cancel', onClick: closeModal }],
      true
    );
    const inp = $('picker-search');
    inp.addEventListener('input', () => { query = inp.value; renderList(); });
    setTimeout(() => inp.focus(), 30);
    renderList();
  }

  function openIconPicker(onSelect) {
    let query = '';
    const icons = state.catalog.icons || [];
    const renderIcons = () => {
      const q = query.toLowerCase();
      const list = icons.filter((i) => !q || i.toLowerCase().includes(q)).slice(0, 240);
      const grid = $('icon-picker-grid');
      grid.innerHTML = list.map((ic) => `
        <div class="icon-tile" data-icon="${esc(ic)}">
          ${spriteImg(ic, 28)}
          <span>${esc(ic)}</span>
        </div>
      `).join('');
      grid.querySelectorAll('[data-icon]').forEach((el) => {
        el.addEventListener('click', () => { closeModal(); onSelect(el.dataset.icon); });
      });
    };
    openModal(
      'Choose Sprite Icon',
      `<input type="text" id="icon-picker-search" placeholder="Search sprite name (e.g. Icons_12, Icons2_62)..." style="width:100%;" />
       <div class="icon-grid" id="icon-picker-grid"></div>`,
      [{ label: 'Cancel', onClick: closeModal }],
      true
    );
    const inp = $('icon-picker-search');
    inp.addEventListener('input', () => { query = inp.value; renderIcons(); });
    setTimeout(() => inp.focus(), 30);
    renderIcons();
  }

  // --- Deep Item / Equipment / Adventurer Editor Modal ---
  function openItemEditor(itemValue, onSave, onDelete = null) {
    const working = deepClone(itemValue);
    let obj = typeof working === 'object' && working !== null ? working : null;
    let parsed = parseTypeString(obj ? obj.Type : working);
    const catEntries = Object.values(state.maps.allItems).map((x) => ({
      id: x.Id, name: x.Name, icon: x.Icon, sub: x.itemClass || x.Type || '',
    }));

    const renderBody = () => {
      const cat = state.maps.allItems[parsed.id];
      const isHumanOrCombat = cat && (cat.itemClass === 'AdventurerItemType' || cat.itemClass === 'HumanItemType' || cat.itemClass === 'CombatantItemType');
      const isEquip = cat && (cat.itemClass === 'EquipmentItemType' || cat.itemClass === 'WeaponItemType');

      const body = `
        <div class="card">
          <div class="row">
            ${spriteImg(cat?.Icon || 'Icons_11', 36)}
            <div style="flex:1;">
              <div style="font-weight:700;font-size:14px;">${esc(cat?.Name || parsed.id)}</div>
              <div class="mono" style="font-size:11px;color:var(--text-muted);">${esc(parsed.id)} ${cat?.itemClass ? '· ' + cat.itemClass : ''}</div>
            </div>
            <button id="ie-pick-type" class="accent sm">Change Item Type</button>
            ${!obj ? `<button id="ie-to-obj" class="sm">Convert to Rich Item Object</button>` : ''}
          </div>
          <div class="form-grid">
            <div class="field">
              <label>Item Type ID</label>
              <input type="text" id="ie-id" value="${esc(parsed.id)}" />
            </div>
            <div class="field">
              <label>Quality (${Math.round(parsed.quality * 100)}%)</label>
              <div class="row">
                <input type="number" step="0.01" min="0.01" id="ie-quality" value="${parsed.quality}" style="flex:1;" />
                <button id="ie-q-1" class="xs">100%</button>
                <button id="ie-q-2" class="xs">200%</button>
                <button id="ie-q-5" class="xs">500%</button>
              </div>
            </div>
            <div class="field">
              <label>Seed</label>
              <div class="row">
                <input type="text" id="ie-seed" value="${esc(parsed.seed)}" style="flex:1;" />
                <button id="ie-gen-seed" class="xs">🎲</button>
              </div>
            </div>
          </div>
        </div>
        ${obj ? `
          <div class="grid grid-2">
            <div class="card">
              <div class="card-header">
                <span class="card-title">Stats</span>
                <div class="row">
                  <button id="ie-boost-stats" class="xs accent">×2 Stats</button>
                  <button id="ie-add-stat" class="xs">+ Stat</button>
                </div>
              </div>
              <div class="form-grid" id="ie-stats-grid">
                ${(state.catalog.stats || []).map((st) => {
                  const val = obj.Stats ? obj.Stats[st] : undefined;
                  if (val === undefined && !(obj.Stats && st in obj.Stats)) return '';
                  return `
                    <div class="field">
                      <label>${esc(st)}</label>
                      <div class="row">
                        <input type="number" class="ie-stat-input" data-stat="${esc(st)}" value="${val}" style="flex:1;" />
                        <button class="xs danger ie-del-stat" data-stat="${esc(st)}">✕</button>
                      </div>
                    </div>
                  `;
                }).join('') || '<div style="color:var(--text-muted);">No Stats object. Click + Stat to add.</div>'}
              </div>
            </div>

            ${('Level' in obj || 'CurrentHealth' in obj || 'CurrentEnergy' in obj || isHumanOrCombat) ? `
              <div class="card">
                <div class="card-header">
                  <span class="card-title">Combatant / Human State</span>
                  <button id="ie-full-heal" class="xs green">Full Heal &amp; Energy</button>
                </div>
                <div class="form-grid">
                  <div class="field"><label>Level</label><input type="number" id="ie-level" value="${obj.Level ?? 0}" /></div>
                  <div class="field"><label>CurrentHealth (0..1)</label><input type="number" step="0.05" min="0" max="1" id="ie-hp" value="${obj.CurrentHealth ?? 1}" /></div>
                  <div class="field"><label>CurrentEnergy (0..1)</label><input type="number" step="0.05" min="0" max="1" id="ie-en" value="${obj.CurrentEnergy ?? 1}" /></div>
                  <div class="field"><label>TrainingCount</label><input type="number" id="ie-train" value="${obj.TrainingCount ?? 0}" /></div>
                  <div class="field"><label>QuestCount</label><input type="number" id="ie-quest" value="${obj.QuestCount ?? 0}" /></div>
                  <div class="field"><label>ArenaCount</label><input type="number" id="ie-arena" value="${obj.ArenaCount ?? 0}" /></div>
                  <div class="field"><label>SpecialCount</label><input type="number" id="ie-special" value="${obj.SpecialCount ?? 0}" /></div>
                </div>
              </div>
            ` : `
              <div class="card">
                <div class="card-header">
                  <span class="card-title">Enhancements (Engrave / Enchant / Blessing)</span>
                  <button id="ie-add-enh" class="xs accent">+ Enhancement</button>
                </div>
                <div id="ie-enh-list" style="display:flex;flex-direction:column;gap:6px;">
                  ${Object.entries(obj.Enhancements || {}).map(([slot, enhStr]) => {
                    const [eid, eq] = String(enhStr).split(':');
                    const ecat = state.maps.enhancements[eid];
                    return `
                      <div class="row" style="background:var(--bg-card);padding:6px;border-radius:4px;border:1px solid var(--border);">
                        ${spriteImg(ecat?.icon, 20)}
                        <strong style="min-width:65px;">${esc(slot)}</strong>
                        <span style="flex:1;">${esc(ecat?.name || eid)} <span class="mono" style="color:var(--text-dim);">(${esc(eid)})</span></span>
                        <label style="font-size:11px;">Q:</label>
                        <input type="number" step="0.05" class="ie-enh-q" data-slot="${esc(slot)}" value="${eq || 1}" style="width:70px;" />
                        <button class="xs danger ie-del-enh" data-slot="${esc(slot)}">✕</button>
                      </div>
                    `;
                  }).join('') || '<div style="color:var(--text-muted);">No enhancements applied.</div>'}
                </div>
              </div>
            `}
          </div>

          ${(Array.isArray(obj.Equipment) || isHumanOrCombat) ? `
            <div class="card">
              <div class="card-header">
                <span class="card-title">Equipped Gear (${(obj.Equipment || []).length})</span>
                <button id="ie-add-equip" class="xs accent">+ Equip Item</button>
              </div>
              <div class="row" id="ie-equip-list">
                ${(obj.Equipment || []).map((eq, idx) => {
                  const sum = getItemSummary(eq);
                  return `
                    <div class="item-chip" data-eq-idx="${idx}">
                      ${spriteImg(sum.icon, 20)}
                      <span>${esc(sum.name)}</span>
                      ${sum.quality !== 1 ? `<span class="badge gold">${Math.round(sum.quality * 100)}%</span>` : ''}
                      <span class="badge">Edit</span>
                    </div>
                  `;
                }).join('') || '<span style="color:var(--text-muted);">No equipment</span>'}
              </div>
            </div>
          ` : ''}
        ` : ''}
      `;

      const footer = [
        ...(onDelete ? [{
          label: 'Delete Item',
          className: 'danger',
          onClick: () => { closeModal(); onDelete(); },
        }] : []),
        { label: 'Cancel', onClick: closeModal },
        {
          label: 'Apply Item',
          className: 'primary',
          onClick: () => {
            syncInputsToObj();
            const finalType = buildTypeString(parsed.id, parsed.quality, parsed.seed);
            if (obj) {
              obj.Type = finalType;
              closeModal();
              onSave(obj);
            } else {
              closeModal();
              onSave(finalType);
            }
          },
        },
      ];

      openModal(`Item Editor · ${esc(cat?.Name || parsed.id)}`, body, footer, true);

      const syncInputsToObj = () => {
        parsed.id = $('ie-id').value.trim() || parsed.id;
        parsed.quality = parseFloat($('ie-quality').value) || 1;
        parsed.seed = $('ie-seed').value.trim();
        if (obj) {
          obj.Type = buildTypeString(parsed.id, parsed.quality, parsed.seed);
          document.querySelectorAll('.ie-stat-input').forEach((inp) => {
            if (!obj.Stats) obj.Stats = {};
            obj.Stats[inp.dataset.stat] = parseInt(inp.value, 10) || 0;
          });
          if ($('ie-level')) obj.Level = parseInt($('ie-level').value, 10) || 0;
          if ($('ie-hp')) obj.CurrentHealth = parseFloat($('ie-hp').value) || 0;
          if ($('ie-en')) obj.CurrentEnergy = parseFloat($('ie-en').value) || 0;
          if ($('ie-train')) {
            const v = parseInt($('ie-train').value, 10) || 0;
            if (v > 0) obj.TrainingCount = v; else delete obj.TrainingCount;
          }
          if ($('ie-quest')) {
            const v = parseInt($('ie-quest').value, 10) || 0;
            if (v > 0) obj.QuestCount = v; else delete obj.QuestCount;
          }
          if ($('ie-arena')) {
            const v = parseInt($('ie-arena').value, 10) || 0;
            if (v > 0) obj.ArenaCount = v; else delete obj.ArenaCount;
          }
          if ($('ie-special')) {
            const v = parseInt($('ie-special').value, 10) || 0;
            if (v > 0) obj.SpecialCount = v; else delete obj.SpecialCount;
          }
          document.querySelectorAll('.ie-enh-q').forEach((inp) => {
            const slot = inp.dataset.slot;
            if (obj.Enhancements && obj.Enhancements[slot]) {
              const eid = String(obj.Enhancements[slot]).split(':')[0];
              obj.Enhancements[slot] = `${eid}:${parseFloat(inp.value) || 1}`;
            }
          });
        }
      };

      $('ie-pick-type')?.addEventListener('click', () => {
        syncInputsToObj();
        openCatalogPicker({
          title: 'Choose Item Type',
          entries: catEntries,
          onSelect: (picked) => {
            if (picked) parsed.id = picked;
            renderBody();
          },
        });
      });

      $('ie-to-obj')?.addEventListener('click', () => {
        syncInputsToObj();
        const c = state.maps.allItems[parsed.id];
        obj = { Type: buildTypeString(parsed.id, parsed.quality, parsed.seed), Stats: { ...(c?.baseStats || {}) } };
        if (c && (c.itemClass === 'AdventurerItemType' || c.itemClass === 'HumanItemType' || c.itemClass === 'CombatantItemType')) {
          obj.CurrentHealth = 1;
          obj.CurrentEnergy = 1;
          obj.Level = 0;
          obj.Equipment = [];
        }
        renderBody();
      });

      $('ie-q-1')?.addEventListener('click', () => { $('ie-quality').value = '1'; });
      $('ie-q-2')?.addEventListener('click', () => { $('ie-quality').value = '2'; });
      $('ie-q-5')?.addEventListener('click', () => { $('ie-quality').value = '5'; });
      $('ie-gen-seed')?.addEventListener('click', () => { $('ie-seed').value = randomSeed(); });

      $('ie-full-heal')?.addEventListener('click', () => {
        syncInputsToObj();
        obj.CurrentHealth = 1;
        obj.CurrentEnergy = 1;
        renderBody();
      });

      $('ie-boost-stats')?.addEventListener('click', () => {
        syncInputsToObj();
        if (!obj.Stats) obj.Stats = {};
        for (const k of Object.keys(obj.Stats)) obj.Stats[k] = Math.round((obj.Stats[k] || 10) * 2);
        renderBody();
      });

      $('ie-add-stat')?.addEventListener('click', () => {
        syncInputsToObj();
        if (!obj.Stats) obj.Stats = {};
        const missing = (state.catalog.stats || []).filter((s) => !(s in obj.Stats));
        if (!missing.length) { toast('All stats already present', 'info'); return; }
        obj.Stats[missing[0]] = 50;
        renderBody();
      });

      document.querySelectorAll('.ie-del-stat').forEach((b) => {
        b.addEventListener('click', () => {
          syncInputsToObj();
          delete obj.Stats[b.dataset.stat];
          renderBody();
        });
      });

      $('ie-add-enh')?.addEventListener('click', () => {
        syncInputsToObj();
        openCatalogPicker({
          title: 'Add Enhancement',
          entries: (state.catalog.enhancements || []).map((e) => ({
            id: e.id, name: e.name, icon: e.icon, sub: e.type,
          })),
          onSelect: (eid) => {
            if (eid) {
              const ecat = state.maps.enhancements[eid];
              if (!obj.Enhancements) obj.Enhancements = {};
              obj.Enhancements[ecat?.type || 'Enchant'] = `${eid}:1`;
            }
            renderBody();
          },
        });
      });

      document.querySelectorAll('.ie-del-enh').forEach((b) => {
        b.addEventListener('click', () => {
          syncInputsToObj();
          if (obj.Enhancements) delete obj.Enhancements[b.dataset.slot];
          renderBody();
        });
      });

      $('ie-add-equip')?.addEventListener('click', () => {
        syncInputsToObj();
        const equipEntries = Object.values(state.maps.items)
          .filter((x) => x.itemClass === 'EquipmentItemType' || x.itemClass === 'WeaponItemType')
          .map((x) => ({ id: x.Id, name: x.Name, icon: x.Icon, sub: x.slot || '' }));
        openCatalogPicker({
          title: 'Equip Item on Adventurer',
          entries: equipEntries.length ? equipEntries : catEntries,
          onSelect: (eid) => {
            if (eid) {
              if (!obj.Equipment) obj.Equipment = [];
              const ec = state.maps.allItems[eid];
              obj.Equipment.push({
                Type: buildTypeString(eid, 1.0, randomSeed()),
                Stats: { ...(ec?.baseStats || { CombatPower: 25 }) },
              });
            }
            renderBody();
          },
        });
      });

      document.querySelectorAll('[data-eq-idx]').forEach((chip) => {
        chip.addEventListener('click', () => {
          syncInputsToObj();
          const idx = parseInt(chip.dataset.eqIdx, 10);
          openItemEditor(
            obj.Equipment[idx],
            (updated) => { obj.Equipment[idx] = updated; renderBody(); },
            () => { obj.Equipment.splice(idx, 1); renderBody(); }
          );
        });
      });
    };

    renderBody();
  }

  // --- Tab Rendering Router ---
  function renderActiveTab() {
    const container = $('tab-content');
    if (!state.data) {
      container.className = 'tab-content';
      container.innerHTML = `
        <div class="empty-state">
          <img class="sprite" src="/sprites/Icons_8.png" style="width:48px;height:48px;" alt="" />
          <div style="font-size:16px;font-weight:700;color:var(--text);">Select a save from the left panel or drop a <code>.save</code> / <code>.json</code> file here</div>
          <div style="max-width:540px;">All saves in your Kingdom Inc directory are auto-discovered. Every write automatically creates a <code>.bak</code> and a timestamped snapshot in <code>.saveeditor_backups/</code>.</div>
        </div>
      `;
      return;
    }

    if (state.activeTab === 'flows') {
      container.className = 'tab-content no-pad';
      renderFlowsTab(container);
      return;
    }

    container.className = 'tab-content';
    switch (state.activeTab) {
      case 'overview': renderOverviewTab(container); break;
      case 'tech': renderTechTab(container); break;
      case 'resources': renderResourcesTab(container); break;
      case 'armory': renderArmoryTab(container); break;
      case 'adventure': renderAdventureTab(container); break;
      case 'cleaner': renderCleanerTab(container); break;
      case 'raw': renderRawTab(container); break;
    }
  }

  function switchTab(tabName) {
    $('tabs-bar').querySelectorAll('.tab-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === tabName);
    });
    state.activeTab = tabName;
    renderActiveTab();
  }

  // --- TAB 1: Overview & Currencies ---
  function renderOverviewTab(root) {
    const d = state.data;
    const p = d.Player || {};
    const curList = state.catalog.currencies || [];
    const knownKeys = new Set([
      'Flows', 'Currency', 'CurrencyEarned', 'ExchangeRate', 'Tech', 'NewTechCount',
      'Resources', 'ResourceUpgradeCount', 'TechTreeCamera', 'TechTreeZoom', 'CurrentFlow',
      'UpgradeCounts', 'UnlockedFlowUpgrades', 'RequisitionTypes', 'WarProgress',
      'UnlockedDungeons', 'GameTime', 'ForestSettings', 'FarmSettings', 'QuestMeta',
      'DungeonMeta', 'Armory', 'Portal', 'Register', 'AscensionCount', 'NightmareCount',
      'NightmareCountActive', 'NightmareProgress', 'NightmareActive', 'PrestigeNodes',
      'FlowCamera', 'FlowZoom',
    ]);
    const extraPlayerKeys = Object.keys(p).filter((k) => !knownKeys.has(k));

    root.innerHTML = `
      <div class="grid grid-2">
        <div class="card">
          <div class="card-header">
            <span class="card-title">Save Metadata &amp; Progression</span>
          </div>
          <div class="form-grid">
            <div class="field">
              <label>Game Version</label>
              <input type="text" id="ov-version" value="${esc(d.Version || '')}" />
            </div>
            <div class="field">
              <label>GameTime (seconds · ${formatDuration(p.GameTime || 0)})</label>
              <input type="number" id="ov-gametime" value="${p.GameTime || 0}" />
            </div>
            <div class="field">
              <label>CurrentFlow Index</label>
              <input type="number" min="0" max="${Math.max(0, (p.Flows || []).length - 1)}" id="ov-curflow" value="${p.CurrentFlow || 0}" />
            </div>
            <div class="field">
              <label>AscensionCount</label>
              <input type="number" min="0" id="ov-ascension" value="${p.AscensionCount || 0}" />
            </div>
            <div class="field">
              <label>NightmareCount</label>
              <input type="number" min="0" id="ov-nm-count" value="${p.NightmareCount || 0}" />
            </div>
            <div class="field">
              <label>NightmareCountActive</label>
              <input type="number" min="0" id="ov-nm-active-cnt" value="${p.NightmareCountActive || 0}" />
            </div>
            <div class="field">
              <label>NightmareProgress (0..1)</label>
              <input type="number" step="0.05" id="ov-nm-prog" value="${p.NightmareProgress ?? 1}" />
            </div>
            <div class="field">
              <label>NightmareActive</label>
              <label class="chk" style="margin-top:6px;">
                <input type="checkbox" id="ov-nm-active" ${p.NightmareActive ? 'checked' : ''} /> Active
              </label>
            </div>
            <div class="field">
              <label>TechTreeCamera X / Y</label>
              <div class="row">
                <input type="number" id="ov-tcam-x" value="${(p.TechTreeCamera || [0, 0])[0]}" style="width:75px;" />
                <input type="number" id="ov-tcam-y" value="${(p.TechTreeCamera || [0, 0])[1]}" style="width:75px;" />
              </div>
            </div>
            <div class="field">
              <label>TechTreeZoom</label>
              <input type="number" id="ov-tzoom" value="${p.TechTreeZoom ?? 3}" />
            </div>
          </div>
          ${'Secret' in d ? `
            <div class="field">
              <label>Secret Hash (1.0.13 legacy FNV-1a)</label>
              <input type="text" id="ov-secret" class="mono" value="${esc(d.Secret || '')}" />
            </div>` : ''}
        </div>

        <div class="card">
          <div class="card-header">
            <span class="card-title">Quick Summary</span>
          </div>
          <div class="grid grid-2">
            <div class="badge" style="justify-content:space-between;padding:8px 12px;"><span>Flows</span><strong>${(p.Flows || []).length}</strong></div>
            <div class="badge" style="justify-content:space-between;padding:8px 12px;"><span>Total Elements</span><strong>${(p.Flows || []).reduce((a, f) => a + (f.Elements || []).length, 0)}</strong></div>
            <div class="badge" style="justify-content:space-between;padding:8px 12px;"><span>Total Pipes</span><strong>${(p.Flows || []).reduce((a, f) => a + (f.Pipes || []).length, 0)}</strong></div>
            <div class="badge" style="justify-content:space-between;padding:8px 12px;"><span>Techs Unlocked</span><strong>${(p.Tech || []).length} / ${(state.catalog.techs || []).length}</strong></div>
            <div class="badge" style="justify-content:space-between;padding:8px 12px;"><span>Prestige Points Spent</span><strong>${Object.values(p.PrestigeNodes || {}).reduce((a, b) => a + Number(b || 0), 0)}</strong></div>
            <div class="badge" style="justify-content:space-between;padding:8px 12px;"><span>Unlocked Dungeons</span><strong>${(p.UnlockedDungeons || []).length} / ${(state.catalog.dungeons || []).length}</strong></div>
          </div>
          ${extraPlayerKeys.length ? `
            <div class="inspector-section" style="margin-top:6px;">
              <h4>Modded / Extra Player Keys Detected</h4>
              ${extraPlayerKeys.map((k) => `
                <div class="field">
                  <label>${esc(k)}</label>
                  <textarea class="mono extra-ply-json" data-key="${esc(k)}" rows="3">${esc(JSON.stringify(p[k], null, 2))}</textarea>
                </div>
              `).join('')}
            </div>
          ` : ''}
        </div>
      </div>

      <div class="card" style="margin-top:14px;">
        <div class="card-header">
          <span class="card-title">Currencies (Balance, Earned &amp; Exchange Rate)</span>
          <div class="row">
            <button id="cur-add-1m" class="sm">+1M All</button>
            <button id="cur-add-1b" class="sm">+1B All</button>
            <button id="cur-sync-earned" class="sm accent">Sync Earned ≥ Balance</button>
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          <div class="currency-row" style="background:transparent;border:none;font-size:11px;color:var(--text-muted);font-weight:600;">
            <div>Currency</div>
            <div>Current Balance</div>
            <div>Total Earned</div>
            <div>Exchange Rate</div>
            <div>Quick Add</div>
          </div>
          ${curList.map((c) => {
            const id = c.Id;
            const bal = (p.Currency || {})[id] ?? '0';
            const earned = (p.CurrencyEarned || {})[id] ?? '0';
            const rate = (p.ExchangeRate || {})[id] ?? 1;
            return `
              <div class="currency-row">
                <div class="row">${spriteImg(c.Icon, 22)}<strong>${esc(c.Name)}</strong></div>
                <input type="text" class="mono cur-bal" data-cur="${esc(id)}" value="${esc(bal)}" />
                <input type="text" class="mono cur-earned" data-cur="${esc(id)}" value="${esc(earned)}" />
                <input type="number" step="0.01" class="cur-rate" data-cur="${esc(id)}" value="${rate}" />
                <div class="row">
                  <button class="xs cur-bump" data-cur="${esc(id)}" data-amt="10000">+10K</button>
                  <button class="xs cur-bump" data-cur="${esc(id)}" data-amt="1000000">+1M</button>
                  <button class="xs cur-bump" data-cur="${esc(id)}" data-amt="1000000000">+1B</button>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;

    const bindNum = (id, fn) => $(id)?.addEventListener('change', (e) => commitChange(`Edit ${id}`, (s) => fn(s, e.target)));
    bindNum('ov-version', (s, el) => { s.Version = el.value; });
    bindNum('ov-gametime', (s, el) => { s.Player.GameTime = parseInt(el.value, 10) || 0; });
    bindNum('ov-curflow', (s, el) => { s.Player.CurrentFlow = parseInt(el.value, 10) || 0; });
    bindNum('ov-ascension', (s, el) => { s.Player.AscensionCount = parseInt(el.value, 10) || 0; });
    bindNum('ov-nm-count', (s, el) => { s.Player.NightmareCount = parseInt(el.value, 10) || 0; });
    bindNum('ov-nm-active-cnt', (s, el) => { s.Player.NightmareCountActive = parseInt(el.value, 10) || 0; });
    bindNum('ov-nm-prog', (s, el) => { s.Player.NightmareProgress = parseFloat(el.value) || 0; });
    bindNum('ov-nm-active', (s, el) => { s.Player.NightmareActive = el.checked; });
    bindNum('ov-tcam-x', (s, el) => {
      if (!s.Player.TechTreeCamera) s.Player.TechTreeCamera = [0, 0];
      s.Player.TechTreeCamera[0] = parseInt(el.value, 10) || 0;
    });
    bindNum('ov-tcam-y', (s, el) => {
      if (!s.Player.TechTreeCamera) s.Player.TechTreeCamera = [0, 0];
      s.Player.TechTreeCamera[1] = parseInt(el.value, 10) || 0;
    });
    bindNum('ov-tzoom', (s, el) => { s.Player.TechTreeZoom = parseInt(el.value, 10) || 3; });
    bindNum('ov-secret', (s, el) => { s.Secret = el.value; });

    document.querySelectorAll('.extra-ply-json').forEach((ta) => {
      ta.addEventListener('change', () => {
        try {
          const parsed = JSON.parse(ta.value);
          commitChange(`Edit ${ta.dataset.key}`, (s) => { s.Player[ta.dataset.key] = parsed; });
        } catch (err) {
          toast(`Invalid JSON in ${ta.dataset.key}: ${err.message}`, 'err');
        }
      });
    });

    document.querySelectorAll('.cur-bal').forEach((inp) => {
      inp.addEventListener('change', () => {
        const c = inp.dataset.cur;
        commitChange(`Set ${c} balance`, (s) => {
          if (!s.Player.Currency) s.Player.Currency = {};
          s.Player.Currency[c] = String(inp.value.trim() || '0');
        });
      });
    });
    document.querySelectorAll('.cur-earned').forEach((inp) => {
      inp.addEventListener('change', () => {
        const c = inp.dataset.cur;
        commitChange(`Set ${c} earned`, (s) => {
          if (!s.Player.CurrencyEarned) s.Player.CurrencyEarned = {};
          s.Player.CurrencyEarned[c] = String(inp.value.trim() || '0');
        });
      });
    });
    document.querySelectorAll('.cur-rate').forEach((inp) => {
      inp.addEventListener('change', () => {
        const c = inp.dataset.cur;
        commitChange(`Set ${c} exchange rate`, (s) => {
          if (!s.Player.ExchangeRate) s.Player.ExchangeRate = {};
          s.Player.ExchangeRate[c] = parseFloat(inp.value) || 0;
        });
      });
    });
    document.querySelectorAll('.cur-bump').forEach((btn) => {
      btn.addEventListener('click', () => {
        const c = btn.dataset.cur;
        const amt = BigInt(btn.dataset.amt);
        commitChange(`Add ${btn.dataset.amt} ${c}`, (s) => {
          if (!s.Player.Currency) s.Player.Currency = {};
          if (!s.Player.CurrencyEarned) s.Player.CurrencyEarned = {};
          const cur = BigInt(s.Player.Currency[c] || '0') + amt;
          const earn = BigInt(s.Player.CurrencyEarned[c] || '0') + amt;
          s.Player.Currency[c] = cur.toString();
          s.Player.CurrencyEarned[c] = earn.toString();
        });
      });
    });

    const bumpAll = (amtStr) => {
      const amt = BigInt(amtStr);
      commitChange(`Add ${amtStr} to all currencies`, (s) => {
        if (!s.Player.Currency) s.Player.Currency = {};
        if (!s.Player.CurrencyEarned) s.Player.CurrencyEarned = {};
        for (const c of curList) {
          s.Player.Currency[c.Id] = (BigInt(s.Player.Currency[c.Id] || '0') + amt).toString();
          s.Player.CurrencyEarned[c.Id] = (BigInt(s.Player.CurrencyEarned[c.Id] || '0') + amt).toString();
        }
      });
    };
    $('cur-add-1m')?.addEventListener('click', () => bumpAll('1000000'));
    $('cur-add-1b')?.addEventListener('click', () => bumpAll('1000000000'));
    $('cur-sync-earned')?.addEventListener('click', () => {
      commitChange('Sync CurrencyEarned >= Currency', (s) => {
        if (!s.Player.CurrencyEarned) s.Player.CurrencyEarned = {};
        for (const [k, v] of Object.entries(s.Player.Currency || {})) {
          const b = BigInt(v || '0');
          const e = BigInt(s.Player.CurrencyEarned[k] || '0');
          if (b > e) s.Player.CurrencyEarned[k] = b.toString();
        }
      });
    });
  }

  // --- TAB 2: Tech Tree & Prestige ---
  function calcPrestigeEffect(id, pts) {
    pts = Number(pts) || 0;
    if (pts <= 0) return '0%';
    let val = 0;
    switch (id) {
      case 'tech_cost_reduce': val = 0.5 + 0.05 * (pts - 1); break;
      case 'resource_cost_reduce': val = 0.05 + 0.02 * (pts - 1); break;
      case 'currency_tax_reduce': val = 0.25 + 0.05 * (pts - 1); break;
      case 'equipment_quality': val = 0.02 * pts; break;
      case 'human_quality': val = 0.02 * pts; break;
      case 'handcrafting_productivity': val = 1 + 0.25 * (pts - 1); break;
      case 'dark_essence_quality': val = 0.1 + 0.05 * (pts - 1); break;
      case 'human_health': val = 0.05 * pts; break;
      case 'sell_value': val = 0.05 * pts; break;
      default: return `${pts} pts`;
    }
    return `${(val * 100).toFixed(1)}%`;
  }

  function renderTechTab(root) {
    const p = state.data.Player;
    const unlockedSet = new Set(p.Tech || []);
    const allTechs = state.catalog.techs || [];
    const branches = Array.from(new Set(allTechs.map((t) => t.Branch || '(Main)'))).sort();
    const unknownTechs = (p.Tech || []).filter((id) => !state.maps.techs[id]);

    const q = state.techSearch.toLowerCase();
    const filteredTechs = allTechs.filter((t) => {
      const isUnlocked = unlockedSet.has(t.Id);
      if (state.techFilter === 'unlocked' && !isUnlocked) return false;
      if (state.techFilter === 'locked' && isUnlocked) return false;
      if (state.techBranch !== 'all' && (t.Branch || '(Main)') !== state.techBranch) return false;
      if (q && !t.Name.toLowerCase().includes(q) && !t.Id.toLowerCase().includes(q) && !(t.Description || '').toLowerCase().includes(q)) return false;
      return true;
    });

    root.innerHTML = `
      <div class="card" style="margin-bottom:14px;">
        <div class="card-header">
          <span class="card-title">Prestige Nodes</span>
          <div class="row">
            <button id="pres-add-1" class="sm">+1 All</button>
            <button id="pres-add-5" class="sm">+5 All</button>
            <button id="pres-reset" class="sm danger">Reset All</button>
          </div>
        </div>
        <div class="grid grid-3">
          ${(state.catalog.prestigeNodes || []).map((pn) => {
            const pts = (p.PrestigeNodes || {})[pn.id] || 0;
            return `
              <div class="tech-card ${pts > 0 ? 'unlocked' : ''}" style="cursor:default;">
                ${spriteImg(pn.icon, 28)}
                <div class="tech-info">
                  <div class="tech-name">${esc(pn.name)} <span class="badge gold">${calcPrestigeEffect(pn.id, pts)}</span></div>
                  <div class="tech-id">${esc(pn.id)}</div>
                  <div class="row" style="margin-top:6px;">
                    <input type="number" min="0" class="pres-input" data-id="${esc(pn.id)}" value="${pts}" style="width:80px;" />
                    <button class="xs pres-bump" data-id="${esc(pn.id)}" data-delta="1">+1</button>
                    <button class="xs pres-bump" data-id="${esc(pn.id)}" data-delta="10">+10</button>
                  </div>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <span class="card-title">Tech Tree (${unlockedSet.size} / ${allTechs.length} unlocked${unknownTechs.length ? ` + ${unknownTechs.length} custom/modded` : ''})</span>
          <div class="row">
            <button id="tech-unlock-all" class="sm accent">Unlock All Vanilla</button>
            <button id="tech-unlock-filtered" class="sm">Unlock Filtered</button>
            <button id="tech-lock-all" class="sm danger">Lock All</button>
            <button id="tech-add-custom" class="sm">+ Custom Tech ID</button>
            <button id="tech-clear-new" class="sm">Clear NewTechCount (${Object.keys(p.NewTechCount || {}).length})</button>
          </div>
        </div>
        <div class="row">
          <input type="text" id="tech-search" value="${esc(state.techSearch)}" placeholder="Search techs by name, ID, or description..." style="flex:1;min-width:220px;" />
          <select id="tech-filter">
            <option value="all" ${state.techFilter === 'all' ? 'selected' : ''}>All (${allTechs.length})</option>
            <option value="unlocked" ${state.techFilter === 'unlocked' ? 'selected' : ''}>Unlocked Only</option>
            <option value="locked" ${state.techFilter === 'locked' ? 'selected' : ''}>Locked Only</option>
          </select>
          <select id="tech-branch">
            <option value="all">All Branches</option>
            ${branches.map((b) => `<option value="${esc(b)}" ${state.techBranch === b ? 'selected' : ''}>${esc(b)}</option>`).join('')}
          </select>
        </div>
        ${unknownTechs.length ? `
          <div class="inspector-section">
            <h4>Custom / Modded Tech IDs in Save (${unknownTechs.length})</h4>
            <div class="row">
              ${unknownTechs.map((id) => `<span class="item-chip del-tech" data-id="${esc(id)}">${esc(id)} <span class="badge red">✕</span></span>`).join('')}
            </div>
          </div>
        ` : ''}
        <div class="tech-grid">
          ${filteredTechs.map((t) => {
            const on = unlockedSet.has(t.Id);
            return `
              <div class="tech-card ${on ? 'unlocked' : ''}" data-tech="${esc(t.Id)}">
                ${spriteImg(t.Icon, 28)}
                <div class="tech-info">
                  <div class="tech-name">${esc(t.Name)} ${on ? '<span class="badge green">✓</span>' : ''}</div>
                  <div class="tech-id">${esc(t.Id)}${t.Branch ? ' · ' + esc(t.Branch) : ''}</div>
                  <div class="tech-desc">${esc(t.Description)}</div>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;

    document.querySelectorAll('.pres-input').forEach((inp) => {
      inp.addEventListener('change', () => {
        commitChange(`Set prestige ${inp.dataset.id}`, (s) => {
          if (!s.Player.PrestigeNodes) s.Player.PrestigeNodes = {};
          const v = parseInt(inp.value, 10) || 0;
          if (v > 0) s.Player.PrestigeNodes[inp.dataset.id] = v;
          else delete s.Player.PrestigeNodes[inp.dataset.id];
        });
      });
    });
    document.querySelectorAll('.pres-bump').forEach((btn) => {
      btn.addEventListener('click', () => {
        commitChange(`Bump prestige ${btn.dataset.id}`, (s) => {
          if (!s.Player.PrestigeNodes) s.Player.PrestigeNodes = {};
          s.Player.PrestigeNodes[btn.dataset.id] = (s.Player.PrestigeNodes[btn.dataset.id] || 0) + parseInt(btn.dataset.delta, 10);
        });
      });
    });
    $('pres-add-1')?.addEventListener('click', () => commitChange('+1 all prestige', (s) => {
      if (!s.Player.PrestigeNodes) s.Player.PrestigeNodes = {};
      for (const pn of state.catalog.prestigeNodes) s.Player.PrestigeNodes[pn.id] = (s.Player.PrestigeNodes[pn.id] || 0) + 1;
    }));
    $('pres-add-5')?.addEventListener('click', () => commitChange('+5 all prestige', (s) => {
      if (!s.Player.PrestigeNodes) s.Player.PrestigeNodes = {};
      for (const pn of state.catalog.prestigeNodes) s.Player.PrestigeNodes[pn.id] = (s.Player.PrestigeNodes[pn.id] || 0) + 5;
    }));
    $('pres-reset')?.addEventListener('click', () => commitChange('Reset prestige', (s) => { s.Player.PrestigeNodes = {}; }));

    $('tech-search').addEventListener('input', (e) => {
      const pos = e.target.selectionStart;
      state.techSearch = e.target.value;
      renderActiveTab();
      const el = $('tech-search');
      if (el) { el.focus(); el.setSelectionRange(pos, pos); }
    });
    $('tech-filter').addEventListener('change', (e) => { state.techFilter = e.target.value; renderActiveTab(); });
    $('tech-branch').addEventListener('change', (e) => { state.techBranch = e.target.value; renderActiveTab(); });

    document.querySelectorAll('[data-tech]').forEach((card) => {
      card.addEventListener('click', () => {
        const id = card.dataset.tech;
        commitChange(`Toggle tech ${id}`, (s) => {
          if (!s.Player.Tech) s.Player.Tech = [];
          const idx = s.Player.Tech.indexOf(id);
          if (idx >= 0) s.Player.Tech.splice(idx, 1);
          else s.Player.Tech.push(id);
        });
      });
    });

    document.querySelectorAll('.del-tech').forEach((chip) => {
      chip.addEventListener('click', () => {
        const id = chip.dataset.id;
        commitChange(`Remove custom tech ${id}`, (s) => {
          s.Player.Tech = (s.Player.Tech || []).filter((x) => x !== id);
        });
      });
    });

    $('tech-unlock-all')?.addEventListener('click', () => {
      commitChange('Unlock all vanilla techs', (s) => {
        const cur = new Set(s.Player.Tech || []);
        for (const t of allTechs) cur.add(t.Id);
        s.Player.Tech = Array.from(cur);
      });
    });
    $('tech-unlock-filtered')?.addEventListener('click', () => {
      commitChange('Unlock filtered techs', (s) => {
        const cur = new Set(s.Player.Tech || []);
        for (const t of filteredTechs) cur.add(t.Id);
        s.Player.Tech = Array.from(cur);
      });
    });
    $('tech-lock-all')?.addEventListener('click', () => {
      if (!confirm('Lock ALL techs?')) return;
      commitChange('Lock all techs', (s) => { s.Player.Tech = []; });
    });
    $('tech-add-custom')?.addEventListener('click', () => {
      const id = prompt('Enter custom/modded Tech ID:');
      if (!id) return;
      commitChange(`Add tech ${id}`, (s) => {
        if (!s.Player.Tech) s.Player.Tech = [];
        if (!s.Player.Tech.includes(id.trim())) s.Player.Tech.push(id.trim());
      });
    });
    $('tech-clear-new')?.addEventListener('click', () => {
      commitChange('Clear NewTechCount', (s) => { s.Player.NewTechCount = {}; });
    });
  }

  // --- TAB 3: Resources, Forest, Farm & Requisitions ---
  function renderResourcesTab(root) {
    const p = state.data.Player;
    const resKeys = Array.from(new Set([
      ...(state.catalog.resourceItems || []),
      ...Object.keys(p.Resources || {}),
      ...Object.keys(p.ResourceUpgradeCount || {}),
    ]));
    const forest = p.ForestSettings || { Workers: { Unassigned: 0, Forager: 0, Logger: 0, Hunter: 0 }, UnlockedItems: [] };
    const farm = p.FarmSettings || { Width: 3, Height: 2, Field: [], UnlockedItems: [] };
    const farmItems = Array.from(new Set([...(state.catalog.farmItems || []), ...(farm.UnlockedItems || [])]));
    const forestItems = Array.from(new Set([...(state.catalog.forestItems || []), ...(forest.UnlockedItems || [])]));

    // Parse farm field into map "x,y" -> cropId
    const fieldMap = {};
    for (const entry of farm.Field || []) {
      const [x, y, crop] = String(entry).split(',');
      if (crop) fieldMap[`${x},${y}`] = crop;
    }

    root.innerHTML = `
      <div class="grid grid-2">
        <div class="card">
          <div class="card-header">
            <span class="card-title">Mine &amp; Base Resources</span>
            <button id="res-add-btn" class="sm accent">+ Add Resource ID</button>
          </div>
          <table class="data-table">
            <thead><tr><th>Resource</th><th>Quota / Rate</th><th>Upgrade Count</th><th></th></tr></thead>
            <tbody>
              ${resKeys.map((id) => {
                const cat = state.maps.allItems[id];
                const amt = (p.Resources || {})[id] ?? 0;
                const upg = (p.ResourceUpgradeCount || {})[id] ?? 0;
                return `
                  <tr>
                    <td><div class="row">${spriteImg(cat?.Icon, 20)} <div><strong>${esc(cat?.Name || id)}</strong><div class="mono" style="font-size:10px;color:var(--text-dim);">${esc(id)}</div></div></div></td>
                    <td><input type="number" step="0.5" class="res-amt" data-id="${esc(id)}" value="${amt}" style="width:110px;" /></td>
                    <td><input type="number" min="0" class="res-upg" data-id="${esc(id)}" value="${upg}" style="width:90px;" /></td>
                    <td><button class="xs danger res-del" data-id="${esc(id)}">✕</button></td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>

        <div class="card">
          <div class="card-header">
            <span class="card-title">Forest Settings</span>
            <button id="forest-unlock-all" class="sm accent">Unlock All Forest Items</button>
          </div>
          <div class="form-grid">
            ${(state.catalog.enums.ForestWorker || []).map((w) => `
              <div class="field">
                <label>${esc(w)} Workers</label>
                <input type="number" min="0" class="forest-worker" data-w="${esc(w)}" value="${(forest.Workers || {})[w] ?? 0}" />
              </div>
            `).join('')}
          </div>
          <div class="field">
            <label>Unlocked Forest Items (${(forest.UnlockedItems || []).length})</label>
            <div class="row">
              ${forestItems.map((fid) => {
                const cat = state.maps.allItems[fid];
                const on = (forest.UnlockedItems || []).includes(fid);
                return `
                  <label class="item-chip" style="border-color:${on ? 'var(--green)' : 'var(--border)'};background:${on ? 'var(--green-dim)' : 'var(--bg-input)'};">
                    <input type="checkbox" class="forest-item-chk" data-id="${esc(fid)}" ${on ? 'checked' : ''} />
                    ${spriteImg(cat?.Icon, 18)}
                    <span>${esc(cat?.Name || fid)}</span>
                  </label>
                `;
              }).join('')}
            </div>
          </div>

          <div class="card-header" style="margin-top:8px;">
            <span class="card-title">Active Requisition Types (${(p.RequisitionTypes || []).length})</span>
            <button id="req-add" class="sm accent">+ Add Item</button>
          </div>
          <div class="row">
            ${(p.RequisitionTypes || []).map((rid, idx) => {
              const cat = state.maps.allItems[rid];
              return `
                <div class="item-chip req-del" data-idx="${idx}" title="Click to remove">
                  ${spriteImg(cat?.Icon, 18)}
                  <span>${esc(cat?.Name || rid)}</span>
                  <span class="badge red">✕</span>
                </div>
              `;
            }).join('') || '<span style="color:var(--text-muted);">None</span>'}
          </div>
        </div>
      </div>

      <div class="card" style="margin-top:14px;">
        <div class="card-header">
          <span class="card-title">Farm Settings &amp; Visual Field Painter (${farm.Width} × ${farm.Height})</span>
          <div class="row">
            <label>W:</label><input type="number" min="1" max="12" id="farm-w" value="${farm.Width}" style="width:60px;" />
            <label>H:</label><input type="number" min="1" max="12" id="farm-h" value="${farm.Height}" style="width:60px;" />
            <button id="farm-unlock-all" class="sm accent">Unlock All Crops</button>
            <button id="farm-fill-brush" class="sm">Fill Field with Brush</button>
            <button id="farm-clear-all" class="sm danger">Clear Field</button>
          </div>
        </div>
        <div class="row">
          <strong style="font-size:12px;">Paint Brush:</strong>
          <button class="sm ${state.farmBrush === '' ? 'primary' : ''}" data-brush="">Eraser (Empty)</button>
          ${farmItems.map((fid) => {
            const cat = state.maps.allItems[fid];
            return `
              <button class="sm ${state.farmBrush === fid ? 'primary' : ''}" data-brush="${esc(fid)}">
                ${spriteImg(cat?.Icon, 16)} ${esc(cat?.Name || fid)}
              </button>
            `;
          }).join('')}
        </div>
        <div class="row" style="align-items:flex-start;gap:20px;margin-top:6px;">
          <div class="farm-grid" style="grid-template-columns: repeat(${farm.Width}, 66px);">
            ${(() => {
              let html = '';
              for (let y = 0; y < farm.Height; y++) {
                for (let x = 0; x < farm.Width; x++) {
                  const crop = fieldMap[`${x},${y}`] || '';
                  const cat = crop ? state.maps.allItems[crop] : null;
                  html += `
                    <div class="farm-cell" data-x="${x}" data-y="${y}" title="(${x},${y}) ${esc(cat?.Name || 'Empty')}">
                      ${crop ? spriteImg(cat?.Icon, 28) : '<span style="color:var(--text-dim);">—</span>'}
                      <span>${esc(cat?.Name || `${x},${y}`)}</span>
                    </div>
                  `;
                }
              }
              return html;
            })()}
          </div>
          <div class="field" style="flex:1;min-width:240px;">
            <label>Unlocked Farm Items</label>
            <div class="row">
              ${farmItems.map((fid) => {
                const cat = state.maps.allItems[fid];
                const on = (farm.UnlockedItems || []).includes(fid);
                return `
                  <label class="item-chip" style="border-color:${on ? 'var(--green)' : 'var(--border)'};background:${on ? 'var(--green-dim)' : 'var(--bg-input)'};">
                    <input type="checkbox" class="farm-item-chk" data-id="${esc(fid)}" ${on ? 'checked' : ''} />
                    ${spriteImg(cat?.Icon, 18)}
                    <span>${esc(cat?.Name || fid)}</span>
                  </label>
                `;
              }).join('')}
            </div>
          </div>
        </div>
      </div>
    `;

    document.querySelectorAll('.res-amt').forEach((inp) => {
      inp.addEventListener('change', () => {
        commitChange(`Set resource ${inp.dataset.id}`, (s) => {
          if (!s.Player.Resources) s.Player.Resources = {};
          const v = parseFloat(inp.value) || 0;
          if (v !== 0) s.Player.Resources[inp.dataset.id] = v;
          else delete s.Player.Resources[inp.dataset.id];
        });
      });
    });
    document.querySelectorAll('.res-upg').forEach((inp) => {
      inp.addEventListener('change', () => {
        commitChange(`Set resource upgrade ${inp.dataset.id}`, (s) => {
          if (!s.Player.ResourceUpgradeCount) s.Player.ResourceUpgradeCount = {};
          const v = parseInt(inp.value, 10) || 0;
          if (v > 0) s.Player.ResourceUpgradeCount[inp.dataset.id] = v;
          else delete s.Player.ResourceUpgradeCount[inp.dataset.id];
        });
      });
    });
    document.querySelectorAll('.res-del').forEach((btn) => {
      btn.addEventListener('click', () => {
        commitChange(`Remove resource ${btn.dataset.id}`, (s) => {
          if (s.Player.Resources) delete s.Player.Resources[btn.dataset.id];
          if (s.Player.ResourceUpgradeCount) delete s.Player.ResourceUpgradeCount[btn.dataset.id];
        });
      });
    });
    $('res-add-btn')?.addEventListener('click', () => {
      openCatalogPicker({
        title: 'Add Resource to Player.Resources',
        entries: Object.values(state.maps.items).map((x) => ({ id: x.Id, name: x.Name, icon: x.Icon, sub: x.itemClass || '' })),
        onSelect: (id) => {
          if (!id) return;
          commitChange(`Add resource ${id}`, (s) => {
            if (!s.Player.Resources) s.Player.Resources = {};
            if (!(id in s.Player.Resources)) s.Player.Resources[id] = 10;
          });
        },
      });
    });

    document.querySelectorAll('.forest-worker').forEach((inp) => {
      inp.addEventListener('change', () => {
        commitChange(`Set forest worker ${inp.dataset.w}`, (s) => {
          if (!s.Player.ForestSettings) s.Player.ForestSettings = { Workers: {}, UnlockedItems: [] };
          if (!s.Player.ForestSettings.Workers) s.Player.ForestSettings.Workers = {};
          s.Player.ForestSettings.Workers[inp.dataset.w] = parseInt(inp.value, 10) || 0;
        });
      });
    });
    document.querySelectorAll('.forest-item-chk').forEach((chk) => {
      chk.addEventListener('change', () => {
        commitChange(`Toggle forest item ${chk.dataset.id}`, (s) => {
          if (!s.Player.ForestSettings) s.Player.ForestSettings = { Workers: {}, UnlockedItems: [] };
          const arr = s.Player.ForestSettings.UnlockedItems || (s.Player.ForestSettings.UnlockedItems = []);
          if (chk.checked && !arr.includes(chk.dataset.id)) arr.push(chk.dataset.id);
          else if (!chk.checked) s.Player.ForestSettings.UnlockedItems = arr.filter((x) => x !== chk.dataset.id);
        });
      });
    });
    $('forest-unlock-all')?.addEventListener('click', () => {
      commitChange('Unlock all forest items', (s) => {
        if (!s.Player.ForestSettings) s.Player.ForestSettings = { Workers: {}, UnlockedItems: [] };
        s.Player.ForestSettings.UnlockedItems = Array.from(new Set([...(s.Player.ForestSettings.UnlockedItems || []), ...(state.catalog.forestItems || [])]));
      });
    });

    $('req-add')?.addEventListener('click', () => {
      openCatalogPicker({
        title: 'Add Requisition Item Type',
        entries: Object.values(state.maps.items).map((x) => ({ id: x.Id, name: x.Name, icon: x.Icon })),
        onSelect: (id) => {
          if (!id) return;
          commitChange(`Add requisition ${id}`, (s) => {
            if (!s.Player.RequisitionTypes) s.Player.RequisitionTypes = [];
            if (!s.Player.RequisitionTypes.includes(id)) s.Player.RequisitionTypes.push(id);
          });
        },
      });
    });
    document.querySelectorAll('.req-del').forEach((chip) => {
      chip.addEventListener('click', () => {
        const idx = parseInt(chip.dataset.idx, 10);
        commitChange('Remove requisition type', (s) => { s.Player.RequisitionTypes.splice(idx, 1); });
      });
    });

    const saveFarmMap = (s, w, h, map) => {
      if (!s.Player.FarmSettings) s.Player.FarmSettings = { Width: w, Height: h, Field: [], UnlockedItems: [] };
      s.Player.FarmSettings.Width = w;
      s.Player.FarmSettings.Height = h;
      const arr = [];
      for (let x = 0; x < w; x++) {
        for (let y = 0; y < h; y++) {
          const c = map[`${x},${y}`];
          if (c) arr.push(`${x},${y},${c}`);
        }
      }
      s.Player.FarmSettings.Field = arr;
    };

    $('farm-w')?.addEventListener('change', (e) => commitChange('Resize farm width', (s) => {
      const nw = Math.max(1, Math.min(12, parseInt(e.target.value, 10) || 3));
      saveFarmMap(s, nw, farm.Height, fieldMap);
    }));
    $('farm-h')?.addEventListener('change', (e) => commitChange('Resize farm height', (s) => {
      const nh = Math.max(1, Math.min(12, parseInt(e.target.value, 10) || 2));
      saveFarmMap(s, farm.Width, nh, fieldMap);
    }));
    document.querySelectorAll('[data-brush]').forEach((b) => {
      b.addEventListener('click', () => { state.farmBrush = b.dataset.brush; renderActiveTab(); });
    });
    document.querySelectorAll('.farm-cell').forEach((cell) => {
      cell.addEventListener('click', () => {
        const key = `${cell.dataset.x},${cell.dataset.y}`;
        commitChange(`Paint farm (${key})`, (s) => {
          const m = { ...fieldMap };
          if (state.farmBrush) m[key] = state.farmBrush;
          else delete m[key];
          saveFarmMap(s, farm.Width, farm.Height, m);
        });
      });
    });
    $('farm-fill-brush')?.addEventListener('click', () => {
      commitChange('Fill farm field', (s) => {
        const m = {};
        if (state.farmBrush) {
          for (let x = 0; x < farm.Width; x++) for (let y = 0; y < farm.Height; y++) m[`${x},${y}`] = state.farmBrush;
        }
        saveFarmMap(s, farm.Width, farm.Height, m);
      });
    });
    $('farm-clear-all')?.addEventListener('click', () => {
      commitChange('Clear farm field', (s) => saveFarmMap(s, farm.Width, farm.Height, {}));
    });
    $('farm-unlock-all')?.addEventListener('click', () => {
      commitChange('Unlock all farm crops', (s) => {
        if (!s.Player.FarmSettings) s.Player.FarmSettings = { Width: 3, Height: 2, Field: [], UnlockedItems: [] };
        s.Player.FarmSettings.UnlockedItems = Array.from(new Set([...(s.Player.FarmSettings.UnlockedItems || []), ...(state.catalog.farmItems || [])]));
      });
    });
    document.querySelectorAll('.farm-item-chk').forEach((chk) => {
      chk.addEventListener('change', () => {
        commitChange(`Toggle farm item ${chk.dataset.id}`, (s) => {
          if (!s.Player.FarmSettings) s.Player.FarmSettings = { Width: 3, Height: 2, Field: [], UnlockedItems: [] };
          const arr = s.Player.FarmSettings.UnlockedItems || (s.Player.FarmSettings.UnlockedItems = []);
          if (chk.checked && !arr.includes(chk.dataset.id)) arr.push(chk.dataset.id);
          else if (!chk.checked) s.Player.FarmSettings.UnlockedItems = arr.filter((x) => x !== chk.dataset.id);
        });
      });
    });
  }

  // --- TAB 4: Interactive Flow Diagrams Canvas + Deep Inspector ---
  const spriteImgCache = {};
  function getCachedSprite(iconName, onLoad) {
    if (!iconName) return null;
    if (spriteImgCache[iconName]) return spriteImgCache[iconName];
    const img = new Image();
    img.src = spriteUrl(iconName);
    img.onload = () => { if (onLoad) onLoad(); };
    spriteImgCache[iconName] = img;
    return img;
  }

  function getActiveFlow() {
    const flows = state.data?.Player?.Flows || [];
    if (state.activeFlowIndex >= flows.length) state.activeFlowIndex = Math.max(0, flows.length - 1);
    return flows[state.activeFlowIndex] || null;
  }

  // --- Unity-Accurate Flow Geometry Helpers ---
  function getElementSize(el) {
    const sizes = state.catalog?.elementSizes || {};
    if (el?.ElementType && sizes[el.ElementType]) return sizes[el.ElementType];
    if (el?.ElementType && el.ElementType.endsWith('Node')) return [128, 128];
    return [192, 128];
  }

  function getIOPortPos(el, io, isInput) {
    const [ex, ey] = el.Position || [0, 0];
    const [ew] = getElementSize(el);
    const mir = !!el.Mirrored;
    const rawPos = io?.Position ?? (isInput ? -10 : 10);
    const eff = mir ? -rawPos : rawPos;
    const onRight = eff >= 0;
    const edgeX = onRight ? ex + ew : ex;
    const attachX = onRight ? ex + ew + 16 : ex - 16;
    const portY = ey - (30 + Math.abs(eff));
    return { edgeX, attachX, portY, onRight };
  }

  function getPipePoints(flow, pipe, byGuid) {
    const src = byGuid[pipe.ConnectedOutput?.Guid];
    const dst = byGuid[pipe.ConnectedInput?.Guid];
    if (!src || !dst) return null;
    const outIO = src.Outputs?.[pipe.ConnectedOutput?.Index || 0];
    const inIO = dst.Inputs?.[pipe.ConnectedInput?.Index || 0];
    const pStart = getIOPortPos(src, outIO, false);
    const pEnd = getIOPortPos(dst, inIO, true);
    return {
      src,
      dst,
      pStart,
      pEnd,
      worldPts: [
        [pStart.attachX, pStart.portY],
        ...(pipe.Nodes || []).map((n) => [n[0], n[1]]),
        [pEnd.attachX, pEnd.portY],
      ],
    };
  }

  function orthogonalizePipe(pipe, byGuid) {
    const src = byGuid[pipe.ConnectedOutput?.Guid];
    const dst = byGuid[pipe.ConnectedInput?.Guid];
    if (!src || !dst) return;
    const outIO = src.Outputs?.[pipe.ConnectedOutput?.Index || 0];
    const inIO = dst.Inputs?.[pipe.ConnectedInput?.Index || 0];
    const a = getIOPortPos(src, outIO, false);
    const b = getIOPortPos(dst, inIO, true);
    const sx = a.onRight ? a.edgeX + 32 : a.edgeX - 32;
    const sy = a.portY;
    const tx = b.onRight ? b.edgeX + 32 : b.edgeX - 32;
    const ty = b.portY;

    const nodes = [];
    const pushPt = (x, y) => {
      const rx = Math.round(x);
      const ry = Math.round(y);
      const prev = nodes[nodes.length - 1];
      if (!prev || prev[0] !== rx || prev[1] !== ry) nodes.push([rx, ry]);
    };

    pushPt(sx, sy);
    if ((a.onRight && !b.onRight && sx <= tx) || (!a.onRight && b.onRight && sx >= tx)) {
      // Direct Z-route
      const midX = Math.round((sx + tx) / 2 / 32) * 32;
      if (sy !== ty) {
        pushPt(midX, sy);
        pushPt(midX, ty);
      }
    } else {
      // Wrap-around U-route above or below
      const [, sh] = getElementSize(src);
      const [, dh] = getElementSize(dst);
      const topClear = Math.max(src.Position[1], dst.Position[1]) + 64;
      const botClear = Math.min(src.Position[1] - sh, dst.Position[1] - dh) - 64;
      const routeY = Math.abs(sy - botClear) <= Math.abs(sy - topClear) ? botClear : topClear;
      const ry = Math.round(routeY / 32) * 32;
      pushPt(sx, ry);
      pushPt(tx, ry);
    }
    pushPt(tx, ty);
    pipe.Nodes = cleanCollinearNodes(nodes);
  }

  function cleanCollinearNodes(nodes) {
    if (!Array.isArray(nodes) || nodes.length === 0) return [];
    const dedup = [];
    for (const n of nodes) {
      if (!Array.isArray(n) || n.length < 2) continue;
      const prev = dedup[dedup.length - 1];
      if (!prev || prev[0] !== n[0] || prev[1] !== n[1]) dedup.push([n[0], n[1]]);
    }
    if (dedup.length <= 2) return dedup;
    const out = [dedup[0]];
    for (let i = 1; i < dedup.length - 1; i++) {
      const a = out[out.length - 1];
      const b = dedup[i];
      const c = dedup[i + 1];
      const sameX = a[0] === b[0] && b[0] === c[0];
      const sameY = a[1] === b[1] && b[1] === c[1];
      if (!sameX && !sameY) out.push(b);
    }
    out.push(dedup[dedup.length - 1]);
    return out;
  }

  function fitFlowCamera() {
    const flow = getActiveFlow();
    if (!flow || !(flow.Elements || []).length) {
      state.cam = { x: 0, y: 0, zoom: 0.7 };
      return;
    }
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const el of flow.Elements) {
      const [x, y] = el.Position || [0, 0];
      const [ew, eh] = getElementSize(el);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x + ew);
      minY = Math.min(minY, y - eh); maxY = Math.max(maxY, y);
    }
    state.cam.x = (minX + maxX) / 2;
    state.cam.y = (minY + maxY) / 2;
    const spanX = Math.max(400, maxX - minX + 320);
    const spanY = Math.max(400, maxY - minY + 320);
    const canvas = $('flow-canvas');
    const w = canvas ? canvas.clientWidth || 800 : 800;
    const h = canvas ? canvas.clientHeight || 600 : 600;
    state.cam.zoom = Math.max(0.08, Math.min(1.5, Math.min(w / spanX, h / spanY)));
  }

  function getElementIconName(el) {
    if (el.Recipe && state.maps.recipes[el.Recipe]?.Icon) return state.maps.recipes[el.Recipe].Icon;
    if (el.Resource && state.maps.allItems[el.Resource]?.Icon) return state.maps.allItems[el.Resource].Icon;
    if (el.SelectedResource && state.maps.allItems[el.SelectedResource]?.Icon) return state.maps.allItems[el.SelectedResource].Icon;
    if (el.FilterType && state.maps.allItems[el.FilterType]?.Icon) return state.maps.allItems[el.FilterType].Icon;
    return state.maps.elements[el.ElementType]?.Icon || 'Icons_1';
  }

  function renderFlowsTab(root) {
    const flows = state.data.Player.Flows || [];
    const active = getActiveFlow();
    const selCount = state.selectedElements.length || (state.selectedKind === 'element' && state.selectedIndex >= 0 ? 1 : 0);

    root.innerHTML = `
      <div class="flow-studio">
        <div class="flow-left">
          <div class="sidebar-header">
            <div class="row">
              <strong style="font-size:12px;color:var(--gold);">Flows (${flows.length})</strong>
              <span class="spacer"></span>
              <button id="flow-add" class="xs accent">+ New</button>
            </div>
          </div>
          <div class="sidebar-list" id="flow-list">
            ${flows.map((f, idx) => `
              <div class="flow-diagram-item ${idx === state.activeFlowIndex ? 'active' : ''}" data-fidx="${idx}">
                ${spriteImg(f.IconName || 'Icons_1', 22)}
                <div style="flex:1;min-width:0;">
                  <div style="font-weight:600;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(f.Label || `Flow #${idx + 1}`)}</div>
                  <div style="font-size:10.5px;color:var(--text-muted);">${(f.Elements || []).length} els · ${(f.Pipes || []).length} pipes</div>
                </div>
                ${state.data.Player.CurrentFlow === idx ? '<span class="badge gold" title="Active in-game tab">★</span>' : ''}
              </div>
            `).join('')}
          </div>
          ${active ? `
            <div style="padding:10px;border-top:1px solid var(--border);display:flex;flex-direction:column;gap:8px;">
              <div class="field"><label>Flow Label</label><input type="text" id="flow-label" value="${esc(active.Label || '')}" /></div>
              <div class="row">
                <button id="flow-pick-icon" class="xs" style="flex:1;">Icon: ${esc(active.IconName || 'None')}</button>
                <button id="flow-set-active" class="xs gold">Set In-Game Tab</button>
              </div>
              <div class="row">
                <button id="flow-clone" class="xs" style="flex:1;">Duplicate</button>
                <button id="flow-del" class="xs danger">Delete</button>
              </div>
            </div>
          ` : ''}
        </div>

        <div class="flow-canvas-wrap">
          <canvas class="flow-canvas" id="flow-canvas"></canvas>
          <div class="flow-hud-top">
            <div class="flow-hud-row">
              <div class="flow-toolbar">
                <button id="ft-select" class="xs ${state.flowTool === 'select' ? 'primary' : ''}">Select / Drag</button>
                <button id="ft-box" class="xs ${state.flowTool === 'box' ? 'primary' : ''}" title="Drag rectangle to multi-select elements">Box Select</button>
                <button id="ft-connect" class="xs ${state.flowTool === 'connect' ? 'primary' : ''}">Connect Pipe</button>
                <button id="ft-add-el" class="xs accent">+ Element</button>
                <button id="ft-add-deco" class="xs">+ Deco</button>
                <button id="ft-fit" class="xs">Fit View</button>
                <select id="ft-snap" class="xs" style="padding:2px 5px;font-size:11px;">
                  <option value="64" ${state.gridSnap === 64 ? 'selected' : ''}>Snap: 64px (Game Grid)</option>
                  <option value="32" ${state.gridSnap === 32 ? 'selected' : ''}>Snap: 32px</option>
                  <option value="16" ${state.gridSnap === 16 ? 'selected' : ''}>Snap: 16px</option>
                  <option value="0" ${state.gridSnap === 0 ? 'selected' : ''}>Snap: Off</option>
                </select>
              </div>
            </div>
            <div class="flow-hud-row">
              <div class="flow-toolbar">
                <span style="font-size:11px;color:var(--gold);font-weight:600;">Align (${selCount || 'All'}):</span>
                <button id="fa-left" class="xs" title="Align Left Edges">◧ Left</button>
                <button id="fa-cx" class="xs" title="Align Horizontal Centers">◫ Center X</button>
                <button id="fa-right" class="xs" title="Align Right Edges">◨ Right</button>
                <button id="fa-top" class="xs" title="Align Top Edges">⬒ Top</button>
                <button id="fa-cy" class="xs" title="Align Vertical Centers">⬓ Center Y</button>
                <button id="fa-bot" class="xs" title="Align Bottom Edges">⬓ Bottom</button>
                <button id="fa-dist-h" class="xs" title="Distribute Horizontally">⬌ Dist H</button>
                <button id="fa-dist-v" class="xs" title="Distribute Vertically">⬍ Dist V</button>
                <button id="fa-snap64" class="xs accent" title="Snap selected (or all) elements &amp; decos to 64px grid">⊞ Snap 64px</button>
                <button id="fa-ortho-pipes" class="xs accent" title="Route pipes cleanly at 90° angles between ports">↴ Orthogonalize Pipes</button>
                <button id="fa-wrap-deco" class="xs" title="Wrap selected elements in a new Deco container">▢ Wrap in Deco</button>
              </div>
            </div>
          </div>
          <div class="flow-hud-bottom">
            <div class="flow-toolbar" style="font-size:11px;color:var(--text-muted);">
              <span id="flow-status-readout">Ctrl+Click: multi-select · Shift+Drag / Middle-Drag: Pan · Wheel: Zoom · Drag Pipe Nodes when pipe selected</span>
            </div>
          </div>
        </div>

        <aside class="flow-inspector">
          <div class="sidebar-header">
            <div class="row">
              <strong style="font-size:12px;color:var(--gold);">Inspector ${state.selectedElements.length > 1 ? `(${state.selectedElements.length} selected)` : ''}</strong>
              <span class="spacer"></span>
              ${state.selectedKind ? `<button id="insp-delete" class="xs danger">Delete Selected</button>` : ''}
            </div>
          </div>
          <div class="flow-inspector-body" id="flow-inspector-body"></div>
        </aside>
      </div>
    `;

    // Flow list handlers
    document.querySelectorAll('[data-fidx]').forEach((el) => {
      el.addEventListener('click', () => {
        state.activeFlowIndex = parseInt(el.dataset.fidx, 10);
        state.selectedKind = null;
        state.selectedIndex = -1;
        state.connectStart = null;
        fitFlowCamera();
        renderActiveTab();
      });
    });

    $('flow-add')?.addEventListener('click', () => {
      commitChange('Create new FlowDiagram', (s) => {
        s.Player.Flows.push({
          Elements: [],
          Pipes: [],
          Decorations: [],
          Label: `Flow ${s.Player.Flows.length + 1}`,
          IconName: 'Icons_1',
          CameraPos: [0, 0],
          Zoom: 2,
        });
        state.activeFlowIndex = s.Player.Flows.length - 1;
        state.selectedKind = null;
      });
    });

    $('flow-label')?.addEventListener('change', (e) => {
      commitChange('Rename flow', (s) => { s.Player.Flows[state.activeFlowIndex].Label = e.target.value; });
    });
    $('flow-pick-icon')?.addEventListener('click', () => {
      openIconPicker((ic) => {
        commitChange('Change flow icon', (s) => { s.Player.Flows[state.activeFlowIndex].IconName = ic; });
      });
    });
    $('flow-set-active')?.addEventListener('click', () => {
      commitChange('Set CurrentFlow', (s) => { s.Player.CurrentFlow = state.activeFlowIndex; });
    });
    $('flow-clone')?.addEventListener('click', () => {
      commitChange('Duplicate flow', (s) => {
        const copy = deepClone(s.Player.Flows[state.activeFlowIndex]);
        copy.Label = (copy.Label || 'Flow') + ' (Copy)';
        const guidMap = {};
        for (const el of copy.Elements || []) {
          const ng = crypto.randomUUID ? crypto.randomUUID() : randomSeed(16);
          guidMap[el.Guid] = ng;
          el.Guid = ng;
        }
        for (const pipe of copy.Pipes || []) {
          if (pipe.ConnectedOutput && guidMap[pipe.ConnectedOutput.Guid]) pipe.ConnectedOutput.Guid = guidMap[pipe.ConnectedOutput.Guid];
          if (pipe.ConnectedInput && guidMap[pipe.ConnectedInput.Guid]) pipe.ConnectedInput.Guid = guidMap[pipe.ConnectedInput.Guid];
        }
        s.Player.Flows.push(copy);
        state.activeFlowIndex = s.Player.Flows.length - 1;
      });
    });
    $('flow-del')?.addEventListener('click', () => {
      if (flows.length <= 1) { toast('Cannot delete the last FlowDiagram.', 'err'); return; }
      if (!confirm('Delete this entire FlowDiagram?')) return;
      commitChange('Delete flow', (s) => {
        s.Player.Flows.splice(state.activeFlowIndex, 1);
        state.activeFlowIndex = Math.max(0, state.activeFlowIndex - 1);
        if (s.Player.CurrentFlow >= s.Player.Flows.length) s.Player.CurrentFlow = s.Player.Flows.length - 1;
        state.selectedKind = null;
      });
    });

    // Toolbar handlers
    $('ft-select')?.addEventListener('click', () => { state.flowTool = 'select'; state.connectStart = null; renderActiveTab(); });
    $('ft-box')?.addEventListener('click', () => { state.flowTool = 'box'; state.connectStart = null; toast('Drag on canvas to box-select multiple elements.', 'info'); renderActiveTab(); });
    $('ft-connect')?.addEventListener('click', () => { state.flowTool = 'connect'; state.connectStart = null; toast('Click source element (Output), then target element (Input).', 'info'); renderActiveTab(); });
    $('ft-fit')?.addEventListener('click', () => { fitFlowCamera(); drawFlowCanvas(); });
    $('ft-snap')?.addEventListener('change', (e) => { state.gridSnap = parseInt(e.target.value, 10) || 0; });

    const getTargetElementIndices = (fl) => {
      if (state.selectedElements.length > 0) return [...state.selectedElements];
      if (state.selectedKind === 'element' && state.selectedIndex >= 0) return [state.selectedIndex];
      return (fl.Elements || []).map((_, i) => i);
    };

    const alignElements = (mode) => {
      const fl = getActiveFlow();
      if (!fl) return;
      const idxs = getTargetElementIndices(fl);
      if (idxs.length < 2) { toast('Select 2+ elements (Ctrl+Click or Box Select) or align all.', 'info'); return; }
      commitChange(`Align ${mode}`, (s) => {
        const els = s.Player.Flows[state.activeFlowIndex].Elements;
        const boxes = idxs.map((i) => {
          const el = els[i];
          const [w, h] = getElementSize(el);
          return { i, el, x: el.Position[0], y: el.Position[1], w, h };
        });
        const minX = Math.min(...boxes.map((b) => b.x));
        const maxR = Math.max(...boxes.map((b) => b.x + b.w));
        const maxY = Math.max(...boxes.map((b) => b.y));
        const minB = Math.min(...boxes.map((b) => b.y - b.h));
        const avgCX = boxes.reduce((a, b) => a + b.x + b.w / 2, 0) / boxes.length;
        const avgCY = boxes.reduce((a, b) => a + b.y - b.h / 2, 0) / boxes.length;

        if (mode === 'left') boxes.forEach((b) => { b.el.Position[0] = Math.round(minX); });
        else if (mode === 'right') boxes.forEach((b) => { b.el.Position[0] = Math.round(maxR - b.w); });
        else if (mode === 'cx') boxes.forEach((b) => { b.el.Position[0] = Math.round((avgCX - b.w / 2) / 32) * 32; });
        else if (mode === 'top') boxes.forEach((b) => { b.el.Position[1] = Math.round(maxY); });
        else if (mode === 'bottom') boxes.forEach((b) => { b.el.Position[1] = Math.round(minB + b.h); });
        else if (mode === 'cy') boxes.forEach((b) => { b.el.Position[1] = Math.round((avgCY + b.h / 2) / 32) * 32; });
        else if (mode === 'dist-h' && boxes.length >= 3) {
          boxes.sort((a, b) => a.x - b.x);
          const totalW = boxes.reduce((a, b) => a + b.w, 0);
          const span = (boxes[boxes.length - 1].x + boxes[boxes.length - 1].w) - boxes[0].x;
          const gap = (span - totalW) / (boxes.length - 1);
          let curX = boxes[0].x;
          for (const b of boxes) { b.el.Position[0] = Math.round(curX / 32) * 32; curX += b.w + gap; }
        } else if (mode === 'dist-v' && boxes.length >= 3) {
          boxes.sort((a, b) => b.y - a.y); // top to bottom (higher Y first)
          const totalH = boxes.reduce((a, b) => a + b.h, 0);
          const span = boxes[0].y - (boxes[boxes.length - 1].y - boxes[boxes.length - 1].h);
          const gap = (span - totalH) / (boxes.length - 1);
          let curY = boxes[0].y;
          for (const b of boxes) { b.el.Position[1] = Math.round(curY / 32) * 32; curY -= b.h + gap; }
        }
      });
    };

    $('fa-left')?.addEventListener('click', () => alignElements('left'));
    $('fa-cx')?.addEventListener('click', () => alignElements('cx'));
    $('fa-right')?.addEventListener('click', () => alignElements('right'));
    $('fa-top')?.addEventListener('click', () => alignElements('top'));
    $('fa-cy')?.addEventListener('click', () => alignElements('cy'));
    $('fa-bot')?.addEventListener('click', () => alignElements('bottom'));
    $('fa-dist-h')?.addEventListener('click', () => alignElements('dist-h'));
    $('fa-dist-v')?.addEventListener('click', () => alignElements('dist-v'));

    $('fa-snap64')?.addEventListener('click', () => {
      const fl = getActiveFlow();
      if (!fl) return;
      const idxs = getTargetElementIndices(fl);
      commitChange('Snap elements to 64px grid', (s) => {
        const flow = s.Player.Flows[state.activeFlowIndex];
        for (const i of idxs) {
          const el = flow.Elements[i];
          if (el) el.Position = [Math.round(el.Position[0] / 64) * 64, Math.round(el.Position[1] / 64) * 64];
        }
        if (state.selectedElements.length === 0 && state.selectedKind !== 'element') {
          for (const dc of flow.Decorations || []) {
            dc.Position = [Math.round(dc.Position[0] / 64) * 64, Math.round(dc.Position[1] / 64) * 64];
            dc.Size = [Math.max(64, Math.round(dc.Size[0] / 64) * 64), Math.max(64, Math.round(dc.Size[1] / 64) * 64)];
          }
        }
      });
      toast(`Snapped ${idxs.length} elements to 64px game grid`, 'ok');
    });

    $('fa-ortho-pipes')?.addEventListener('click', () => {
      const fl = getActiveFlow();
      if (!fl) return;
      commitChange('Orthogonalize pipes', (s) => {
        const flow = s.Player.Flows[state.activeFlowIndex];
        const byG = {};
        (flow.Elements || []).forEach((el) => { byG[el.Guid] = el; });
        if (state.selectedKind === 'pipe' && state.selectedIndex >= 0) {
          orthogonalizePipe(flow.Pipes[state.selectedIndex], byG);
        } else {
          const selGuids = new Set(state.selectedElements.map((i) => flow.Elements[i]?.Guid).filter(Boolean));
          if (state.selectedKind === 'element' && flow.Elements[state.selectedIndex]) selGuids.add(flow.Elements[state.selectedIndex].Guid);
          for (const pp of flow.Pipes || []) {
            if (selGuids.size === 0 || selGuids.has(pp.ConnectedOutput?.Guid) || selGuids.has(pp.ConnectedInput?.Guid)) {
              orthogonalizePipe(pp, byG);
            }
          }
        }
      });
      toast('Pipes routed cleanly along 90° orthogonal tracks', 'ok');
    });

    $('fa-wrap-deco')?.addEventListener('click', () => {
      const fl = getActiveFlow();
      if (!fl) return;
      const idxs = getTargetElementIndices(fl);
      if (!idxs.length) return;
      let minX = Infinity, maxR = -Infinity, maxY = -Infinity, minB = Infinity;
      for (const i of idxs) {
        const el = fl.Elements[i];
        const [w, h] = getElementSize(el);
        minX = Math.min(minX, el.Position[0]);
        maxR = Math.max(maxR, el.Position[0] + w);
        maxY = Math.max(maxY, el.Position[1]);
        minB = Math.min(minB, el.Position[1] - h);
      }
      const pad = 64;
      const dx = Math.floor((minX - pad) / 64) * 64;
      const dy = Math.ceil((maxY + pad) / 64) * 64;
      const dw = Math.ceil((maxR + pad - dx) / 64) * 64;
      const dh = Math.ceil((dy - (minB - pad)) / 64) * 64;
      commitChange('Wrap in Deco container', (s) => {
        const flow = s.Player.Flows[state.activeFlowIndex];
        if (!flow.Decorations) flow.Decorations = [];
        flow.Decorations.push({ Position: [dx, dy], Size: [dw, dh], StyleIndex: 0, IsParent: true });
        state.selectedKind = 'deco';
        state.selectedIndex = flow.Decorations.length - 1;
        state.selectedElements = [];
      });
    });

    $('ft-add-el')?.addEventListener('click', () => {
      const entries = (state.catalog.elements || []).map((e) => ({
        id: e.Id, name: e.Name, icon: e.Icon, sub: e.Id,
      }));
      openCatalogPicker({
        title: 'Add Element to Flow',
        entries,
        onSelect: (typeId) => {
          if (!typeId) return;
          const gx = state.gridSnap ? Math.round(state.cam.x / state.gridSnap) * state.gridSnap : Math.round(state.cam.x);
          const gy = state.gridSnap ? Math.round(state.cam.y / state.gridSnap) * state.gridSnap : Math.round(state.cam.y);
          commitChange(`Add ${typeId}`, (s) => {
            const fl = s.Player.Flows[state.activeFlowIndex];
            const el = {
              Guid: crypto.randomUUID ? crypto.randomUUID() : randomSeed(16),
              ElementType: typeId,
              Position: [gx, gy],
              Inputs: [{ Position: -10, BufferedItems: [] }],
              Outputs: [{ Position: 10, BufferedItems: [] }],
            };
            fl.Elements.push(el);
            state.selectedKind = 'element';
            state.selectedIndex = fl.Elements.length - 1;
          });
        },
      });
    });

    $('ft-add-deco')?.addEventListener('click', () => {
      const gx = Math.round(state.cam.x);
      const gy = Math.round(state.cam.y);
      commitChange('Add FlowDeco', (s) => {
        const fl = s.Player.Flows[state.activeFlowIndex];
        if (!fl.Decorations) fl.Decorations = [];
        fl.Decorations.push({
          Position: [gx, gy],
          Size: [256, 256],
          StyleIndex: 0,
          Label: 'New Zone',
        });
        state.selectedKind = 'deco';
        state.selectedIndex = fl.Decorations.length - 1;
      });
    });

    $('insp-delete')?.addEventListener('click', deleteSelectedFlowItem);

    setupFlowCanvasInteractions();
    drawFlowCanvas();
    renderFlowInspector();
  }

  function deleteSelectedFlowItem() {
    const flow = getActiveFlow();
    if (!flow) return;
    if (state.selectedElements.length > 0) {
      const toDel = new Set(state.selectedElements);
      commitChange(`Delete ${toDel.size} elements`, (s) => {
        const fl = s.Player.Flows[state.activeFlowIndex];
        const delGuids = new Set();
        fl.Elements = (fl.Elements || []).filter((el, i) => {
          if (toDel.has(i)) { delGuids.add(el.Guid); return false; }
          return true;
        });
        fl.Pipes = (fl.Pipes || []).filter((p) => !delGuids.has(p.ConnectedOutput?.Guid) && !delGuids.has(p.ConnectedInput?.Guid));
        state.selectedElements = [];
        state.selectedKind = null;
        state.selectedIndex = -1;
      });
      return;
    }
    if (state.selectedIndex < 0) return;
    if (state.selectedKind === 'element') {
      const el = flow.Elements[state.selectedIndex];
      commitChange(`Delete element ${el.ElementType}`, (s) => {
        const fl = s.Player.Flows[state.activeFlowIndex];
        const guid = fl.Elements[state.selectedIndex].Guid;
        fl.Elements.splice(state.selectedIndex, 1);
        fl.Pipes = (fl.Pipes || []).filter((p) => p.ConnectedOutput?.Guid !== guid && p.ConnectedInput?.Guid !== guid);
        state.selectedKind = null;
        state.selectedIndex = -1;
      });
    } else if (state.selectedKind === 'pipe') {
      commitChange('Delete pipe', (s) => {
        s.Player.Flows[state.activeFlowIndex].Pipes.splice(state.selectedIndex, 1);
        state.selectedKind = null;
        state.selectedIndex = -1;
      });
    } else if (state.selectedKind === 'deco') {
      commitChange('Delete deco', (s) => {
        s.Player.Flows[state.activeFlowIndex].Decorations.splice(state.selectedIndex, 1);
        state.selectedKind = null;
        state.selectedIndex = -1;
      });
    }
  }

  function worldToScreen(wx, wy, canvas) {
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    // Unity world Y is up, canvas Y is down
    return [
      cx + (wx - state.cam.x) * state.cam.zoom,
      cy - (wy - state.cam.y) * state.cam.zoom,
    ];
  }

  function screenToWorld(sx, sy, canvas) {
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    return [
      state.cam.x + (sx - cx) / state.cam.zoom,
      state.cam.y - (sy - cy) / state.cam.zoom,
    ];
  }

  function drawFlowCanvas() {
    const canvas = $('flow-canvas');
    if (!canvas) return;
    const rect = canvas.parentElement.getBoundingClientRect();
    if (canvas.width !== Math.floor(rect.width) || canvas.height !== Math.floor(rect.height)) {
      canvas.width = Math.max(100, Math.floor(rect.width));
      canvas.height = Math.max(100, Math.floor(rect.height));
    }
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    // 64px minor / 256px major game grid
    const [wx0, wy0] = screenToWorld(0, h, canvas);
    const [wx1, wy1] = screenToWorld(w, 0, canvas);
    const minor = 64;
    if (minor * state.cam.zoom > 10) {
      ctx.strokeStyle = 'rgba(255,255,255,0.035)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let gx = Math.floor(wx0 / minor) * minor; gx <= wx1; gx += minor) {
        const [sx] = worldToScreen(gx, 0, canvas);
        ctx.moveTo(sx, 0); ctx.lineTo(sx, h);
      }
      for (let gy = Math.floor(wy0 / minor) * minor; gy <= wy1; gy += minor) {
        const [, sy] = worldToScreen(0, gy, canvas);
        ctx.moveTo(0, sy); ctx.lineTo(w, sy);
      }
      ctx.stroke();
    }
    const major = 256;
    if (major * state.cam.zoom > 16) {
      ctx.strokeStyle = 'rgba(255,255,255,0.075)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let gx = Math.floor(wx0 / major) * major; gx <= wx1; gx += major) {
        const [sx] = worldToScreen(gx, 0, canvas);
        ctx.moveTo(sx, 0); ctx.lineTo(sx, h);
      }
      for (let gy = Math.floor(wy0 / major) * major; gy <= wy1; gy += major) {
        const [, sy] = worldToScreen(0, gy, canvas);
        ctx.moveTo(0, sy); ctx.lineTo(w, sy);
      }
      ctx.stroke();
    }

    const flow = getActiveFlow();
    if (!flow) return;

    const decoStyles = state.catalog.enums.DecoStyles || [];
    // 1. Decorations (TOP-LEFT pivot [dx, dy], spans [dx, dx+dw] x [dy-dh, dy])
    (flow.Decorations || []).forEach((deco, idx) => {
      const [px, py] = deco.Position || [0, 0];
      const [sw, sh] = deco.Size || [128, 128];
      const [sx, sy] = worldToScreen(px, py, canvas);
      const pw = sw * state.cam.zoom;
      const ph = sh * state.cam.zoom;
      if (sx + pw < 0 || sx > w || sy + ph < 0 || sy > h) return;

      const style = decoStyles[deco.StyleIndex || 0] || { color: '#4b5563' };
      const selected = state.selectedKind === 'deco' && state.selectedIndex === idx;

      ctx.save();
      ctx.fillStyle = style.color + '20';
      ctx.strokeStyle = selected ? '#f0c96d' : style.color + '99';
      ctx.lineWidth = selected ? 2.5 : 1.3;
      ctx.beginPath();
      ctx.roundRect(sx, sy, pw, ph, Math.max(3, 6 * state.cam.zoom));
      ctx.fill();
      ctx.stroke();

      if (deco.Label && state.cam.zoom > 0.22) {
        ctx.fillStyle = '#e6edf7';
        ctx.font = `600 ${Math.max(9, Math.min(18, 16 * state.cam.zoom))}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText(deco.Label, sx + pw / 2, sy + 20 * Math.min(1.2, state.cam.zoom + 0.15));
      }
      if (deco.Sticker?.IconName) {
        const img = getCachedSprite(deco.Sticker.IconName, drawFlowCanvas);
        if (img && img.complete && img.naturalWidth > 0) {
          const isz = Math.min(pw, ph) * 0.72;
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(img, sx + (pw - isz) / 2, sy + (ph - isz) / 2, isz, isz);
        }
      }
      ctx.restore();
    });

    // Element lookup by Guid
    const byGuid = {};
    (flow.Elements || []).forEach((el) => { byGuid[el.Guid] = el; });

    // 2. Pipes (exact port attachment points)
    (flow.Pipes || []).forEach((pipe, idx) => {
      const info = getPipePoints(flow, pipe, byGuid);
      if (!info) return;
      const selected = state.selectedKind === 'pipe' && state.selectedIndex === idx;
      const pts = info.worldPts.map(([x, y]) => worldToScreen(x, y, canvas));

      ctx.save();
      ctx.strokeStyle = selected ? '#f0c96d' : '#5ca8ffaa';
      ctx.lineWidth = selected ? 3.5 : Math.max(1.5, 3.2 * state.cam.zoom);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.stroke();

      // Arrowhead at destination port
      const [ax, ay] = pts[pts.length - 1];
      const [bx, by] = pts[pts.length - 2];
      const ang = Math.atan2(ay - by, ax - bx);
      const r = Math.max(5, 9 * state.cam.zoom);
      ctx.fillStyle = selected ? '#f0c96d' : '#7ec2ff';
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(ax - r * Math.cos(ang - 0.5), ay - r * Math.sin(ang - 0.5));
      ctx.lineTo(ax - r * Math.cos(ang + 0.5), ay - r * Math.sin(ang + 0.5));
      ctx.closePath();
      ctx.fill();

      // Draw draggable waypoint handles when selected
      if (selected && (pipe.Nodes || []).length > 0) {
        pipe.Nodes.forEach((n, ni) => {
          const [nx, ny] = worldToScreen(n[0], n[1], canvas);
          ctx.fillStyle = state.selectedPipeNode === ni ? '#3ddc84' : '#f0c96d';
          ctx.strokeStyle = '#0c1016';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(nx, ny, 6, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        });
      }
      ctx.restore();
    });

    // 3. Elements (TOP-LEFT pivot [ex, ey], exact prefab [ew, eh])
    const multiSet = new Set(state.selectedElements);
    (flow.Elements || []).forEach((el, idx) => {
      const [wx, wy] = el.Position || [0, 0];
      const [ew, eh] = getElementSize(el);
      const [sx, sy] = worldToScreen(wx, wy, canvas);
      const pw = ew * state.cam.zoom;
      const ph = eh * state.cam.zoom;
      if (sx + pw < -24 || sx > w + 24 || sy + ph < -24 || sy > h + 24) return;

      const selected = (state.selectedKind === 'element' && state.selectedIndex === idx) || multiSet.has(idx);
      const isConnectSrc = state.flowTool === 'connect' && state.connectStart?.elIndex === idx;

      ctx.save();

      // StackSize visual layers (matching WorldFlowElement)
      const stack = Math.min(5, el.StackSize || 1);
      if (stack > 1 && state.cam.zoom > 0.25) {
        for (let st = stack - 1; st >= 1; st--) {
          const off = st * 3.5 * state.cam.zoom;
          ctx.fillStyle = '#121923';
          ctx.strokeStyle = '#2d3b52';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.roundRect(sx + off, sy + off, pw, ph, Math.max(3, 6 * state.cam.zoom));
          ctx.fill();
          ctx.stroke();
        }
      }

      // Main card
      ctx.fillStyle = selected ? '#233146' : '#17202e';
      ctx.strokeStyle = isConnectSrc ? '#3ddc84' : selected ? '#f0c96d' : '#3a4b66';
      ctx.lineWidth = selected || isConnectSrc ? 2.4 : 1.2;
      ctx.beginPath();
      ctx.roundRect(sx, sy, pw, ph, Math.max(3, 6 * state.cam.zoom));
      ctx.fill();
      ctx.stroke();

      // Top title strip
      const titleH = Math.min(ph * 0.28, Math.max(12, 28 * state.cam.zoom));
      if (state.cam.zoom > 0.22) {
        ctx.fillStyle = selected ? 'rgba(228,180,76,0.16)' : 'rgba(255,255,255,0.04)';
        ctx.fillRect(sx + 1, sy + 1, Math.max(0, pw - 2), titleH);
        ctx.fillStyle = '#dce6f5';
        ctx.font = `600 ${Math.max(8, Math.min(13, 12 * state.cam.zoom))}px sans-serif`;
        ctx.textAlign = 'center';
        const cat = state.maps.elements[el.ElementType];
        const label = cat ? cat.Name : el.ElementType;
        ctx.fillText(label.slice(0, Math.max(8, Math.floor(pw / 7))), sx + pw / 2, sy + titleH * 0.72);
      }

      // Center sprite icon
      const iconName = getElementIconName(el);
      const img = getCachedSprite(iconName, drawFlowCanvas);
      if (img && img.complete && img.naturalWidth > 0) {
        const isz = Math.min(pw, ph - titleH) * 0.56;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(img, sx + (pw - isz) / 2, sy + titleH + (ph - titleH - isz) / 2, isz, isz);
      }

      // Upgrade pips along bottom
      const upgs = (el.Upgrades || []).filter(Boolean);
      if (upgs.length > 0 && state.cam.zoom > 0.32) {
        const pipR = Math.max(2.5, 4 * state.cam.zoom);
        upgs.forEach((_, ui) => {
          ctx.fillStyle = '#3ddc84';
          ctx.beginPath();
          ctx.arc(sx + 12 * state.cam.zoom + ui * pipR * 2.8, sy + ph - 9 * state.cam.zoom, pipR, 0, Math.PI * 2);
          ctx.fill();
        });
      }

      // Stack badge
      if ((el.StackSize || 1) > 1 && state.cam.zoom > 0.28) {
        ctx.fillStyle = '#e4b44c';
        ctx.font = `bold ${Math.max(8, 11 * state.cam.zoom)}px sans-serif`;
        ctx.textAlign = 'right';
        ctx.fillText(`×${el.StackSize}`, sx + pw - 6 * state.cam.zoom, sy + ph - 6 * state.cam.zoom);
      }

      // Exact IO Port Handles (Input & Output)
      if (state.cam.zoom > 0.24) {
        const portR = Math.max(3, 5.5 * state.cam.zoom);
        for (const io of el.Inputs || []) {
          const p = getIOPortPos(el, io, true);
          const [px, py] = worldToScreen(p.edgeX, p.portY, canvas);
          ctx.fillStyle = (io.BufferedItems?.length || 0) > 0 ? '#3ddc84' : '#2f7d57';
          ctx.strokeStyle = '#0c1016';
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.arc(px, py, portR, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          if ((io.BufferedItems?.length || 0) > 0 && state.cam.zoom > 0.45) {
            ctx.fillStyle = '#9ff3c3';
            ctx.font = `bold ${Math.max(8, 10 * state.cam.zoom)}px monospace`;
            ctx.textAlign = p.onRight ? 'left' : 'right';
            ctx.fillText(String(io.BufferedItems.length), px + (p.onRight ? 8 : -8), py + 3);
          }
        }
        for (const io of el.Outputs || []) {
          const p = getIOPortPos(el, io, false);
          const [px, py] = worldToScreen(p.edgeX, p.portY, canvas);
          ctx.fillStyle = (io.BufferedItems?.length || 0) > 0 ? '#f0c96d' : '#a87d28';
          ctx.strokeStyle = '#0c1016';
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.arc(px, py, portR, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          if ((io.BufferedItems?.length || 0) > 0 && state.cam.zoom > 0.45) {
            ctx.fillStyle = '#fde6a8';
            ctx.font = `bold ${Math.max(8, 10 * state.cam.zoom)}px monospace`;
            ctx.textAlign = p.onRight ? 'left' : 'right';
            ctx.fillText(String(io.BufferedItems.length), px + (p.onRight ? 8 : -8), py + 3);
          }
        }
      }

      ctx.restore();
    });

    // 4. Smart Alignment Guides
    if (state.snapGuides.length > 0) {
      ctx.save();
      ctx.strokeStyle = '#f45b69cc';
      ctx.lineWidth = 1.2;
      ctx.setLineDash([5, 4]);
      for (const g of state.snapGuides) {
        ctx.beginPath();
        if (g.axis === 'x') {
          const [sx] = worldToScreen(g.val, 0, canvas);
          ctx.moveTo(sx, 0); ctx.lineTo(sx, h);
        } else {
          const [, sy] = worldToScreen(0, g.val, canvas);
          ctx.moveTo(0, sy); ctx.lineTo(w, sy);
        }
        ctx.stroke();
      }
      ctx.restore();
    }

    // 5. Box Selection Marquee
    if (state.boxSelect) {
      const { x0, y0, x1, y1 } = state.boxSelect;
      ctx.save();
      ctx.fillStyle = 'rgba(74, 168, 255, 0.14)';
      ctx.strokeStyle = '#4aa8ff';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      const bx = Math.min(x0, x1), by = Math.min(y0, y1);
      const bw = Math.abs(x1 - x0), bh = Math.abs(y1 - y0);
      ctx.fillRect(bx, by, bw, bh);
      ctx.strokeRect(bx, by, bw, bh);
      ctx.restore();
    }
  }

  function setupFlowCanvasInteractions() {
    const canvas = $('flow-canvas');
    if (!canvas) return;
    let mode = null; // 'pan' | 'drag-el' | 'drag-multi' | 'drag-deco' | 'drag-pipe-node' | 'box'
    let startClient = [0, 0];
    let startCam = [0, 0];
    let dragStartPositions = [];
    let dragOriginalJson = null;

    const hitTest = (sx, sy) => {
      const flow = getActiveFlow();
      if (!flow) return null;
      const byGuid = {};
      (flow.Elements || []).forEach((el) => { byGuid[el.Guid] = el; });

      // 0. Selected Pipe Waypoint Nodes
      if (state.selectedKind === 'pipe' && state.selectedIndex >= 0) {
        const pipe = flow.Pipes?.[state.selectedIndex];
        if (pipe?.Nodes) {
          for (let ni = pipe.Nodes.length - 1; ni >= 0; ni--) {
            const [nx, ny] = worldToScreen(pipe.Nodes[ni][0], pipe.Nodes[ni][1], canvas);
            if (Math.hypot(sx - nx, sy - ny) <= 10) {
              return { kind: 'pipe-node', index: ni };
            }
          }
        }
      }

      // 1. Elements (top-left [ex, ey] spanning [ew, eh])
      for (let i = (flow.Elements || []).length - 1; i >= 0; i--) {
        const el = flow.Elements[i];
        const [ex, ey] = worldToScreen(el.Position[0], el.Position[1], canvas);
        const [ew, eh] = getElementSize(el);
        const pw = ew * state.cam.zoom;
        const ph = eh * state.cam.zoom;
        if (sx >= ex && sx <= ex + pw && sy >= ey && sy <= ey + ph) {
          return { kind: 'element', index: i };
        }
      }

      // 2. Pipes
      for (let i = (flow.Pipes || []).length - 1; i >= 0; i--) {
        const info = getPipePoints(flow, flow.Pipes[i], byGuid);
        if (!info) continue;
        const pts = info.worldPts.map(([x, y]) => worldToScreen(x, y, canvas));
        for (let k = 0; k < pts.length - 1; k++) {
          if (pointToSegDist(sx, sy, pts[k][0], pts[k][1], pts[k + 1][0], pts[k + 1][1]) < 8) {
            return { kind: 'pipe', index: i };
          }
        }
      }

      // 3. Decorations (top-left [dx, dy] spanning [dw, dh])
      for (let i = (flow.Decorations || []).length - 1; i >= 0; i--) {
        const deco = flow.Decorations[i];
        const [dx, dy] = worldToScreen(deco.Position[0], deco.Position[1], canvas);
        const pw = (deco.Size?.[0] || 128) * state.cam.zoom;
        const ph = (deco.Size?.[1] || 128) * state.cam.zoom;
        if (sx >= dx && sx <= dx + pw && sy >= dy && sy <= dy + ph) {
          return { kind: 'deco', index: i };
        }
      }
      return null;
    };

    function pointToSegDist(px, py, x1, y1, x2, y2) {
      const dx = x2 - x1, dy = y2 - y1;
      const l2 = dx * dx + dy * dy;
      if (l2 === 0) return Math.hypot(px - x1, py - y1);
      const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / l2));
      return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
    }

    canvas.addEventListener('mousedown', (e) => {
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      startClient = [e.clientX, e.clientY];
      startCam = [state.cam.x, state.cam.y];

      if (e.button === 1 || e.shiftKey) {
        mode = 'pan';
        canvas.classList.add('dragging');
        return;
      }

      if (state.flowTool === 'box') {
        mode = 'box';
        state.boxSelect = { x0: sx, y0: sy, x1: sx, y1: sy };
        drawFlowCanvas();
        return;
      }

      const hit = hitTest(sx, sy);
      if (state.flowTool === 'connect' && hit?.kind === 'element') {
        const flow = getActiveFlow();
        if (!state.connectStart) {
          state.connectStart = { elIndex: hit.index };
          toast(`Source selected: ${flow.Elements[hit.index].ElementType}. Now click destination element.`, 'info');
          drawFlowCanvas();
        } else {
          const srcEl = flow.Elements[state.connectStart.elIndex];
          const dstEl = flow.Elements[hit.index];
          if (srcEl && dstEl && srcEl !== dstEl) {
            commitChange(`Connect ${srcEl.ElementType} → ${dstEl.ElementType}`, (s) => {
              const fl = s.Player.Flows[state.activeFlowIndex];
              const se = fl.Elements[state.connectStart.elIndex];
              const de = fl.Elements[hit.index];
              if (!se.Outputs?.length) se.Outputs = [{ Position: 10, BufferedItems: [] }];
              if (!de.Inputs?.length) de.Inputs = [{ Position: -10, BufferedItems: [] }];
              if (!fl.Pipes) fl.Pipes = [];
              const np = {
                ConnectedOutput: { Guid: se.Guid, Index: 0 },
                ConnectedInput: { Guid: de.Guid, Index: 0 },
                Nodes: [],
              };
              const byG = {};
              fl.Elements.forEach((el) => { byG[el.Guid] = el; });
              orthogonalizePipe(np, byG);
              fl.Pipes.push(np);
              state.selectedKind = 'pipe';
              state.selectedIndex = fl.Pipes.length - 1;
              state.selectedElements = [];
            });
          }
          state.connectStart = null;
          state.flowTool = 'select';
          renderActiveTab();
        }
        return;
      }

      if (hit?.kind === 'pipe-node') {
        const flow = getActiveFlow();
        mode = 'drag-pipe-node';
        state.selectedPipeNode = hit.index;
        dragStartPositions = [[...flow.Pipes[state.selectedIndex].Nodes[hit.index]]];
        dragOriginalJson = JSON.stringify(state.data);
        drawFlowCanvas();
        return;
      }

      if (hit) {
        const flow = getActiveFlow();
        if (hit.kind === 'element' && (e.ctrlKey || e.metaKey)) {
          const set = new Set(state.selectedElements);
          if (state.selectedKind === 'element' && state.selectedIndex >= 0) set.add(state.selectedIndex);
          if (set.has(hit.index)) set.delete(hit.index);
          else set.add(hit.index);
          state.selectedElements = Array.from(set);
          state.selectedKind = state.selectedElements.length ? 'element' : null;
          state.selectedIndex = state.selectedElements.length ? state.selectedElements[state.selectedElements.length - 1] : -1;
          renderActiveTab();
          return;
        }

        if (hit.kind === 'element' && state.selectedElements.includes(hit.index)) {
          mode = 'drag-multi';
          dragStartPositions = state.selectedElements.map((i) => ({ i, pos: [...flow.Elements[i].Position] }));
          dragOriginalJson = JSON.stringify(state.data);
          drawFlowCanvas();
          return;
        }

        state.selectedElements = [];
        state.selectedPipeNode = -1;
        state.selectedKind = hit.kind;
        state.selectedIndex = hit.index;
        if (hit.kind === 'element') {
          mode = 'drag-el';
          dragStartPositions = [[...flow.Elements[hit.index].Position]];
          dragOriginalJson = JSON.stringify(state.data);
        } else if (hit.kind === 'deco') {
          mode = 'drag-deco';
          dragStartPositions = [[...flow.Decorations[hit.index].Position]];
          dragOriginalJson = JSON.stringify(state.data);
        }
        drawFlowCanvas();
        renderFlowInspector();
      } else {
        state.selectedKind = null;
        state.selectedIndex = -1;
        state.selectedElements = [];
        state.selectedPipeNode = -1;
        mode = 'pan';
        canvas.classList.add('dragging');
        drawFlowCanvas();
        renderFlowInspector();
      }
    });

    window.addEventListener('mousemove', (e) => {
      if (!mode) return;
      const rect = canvas.getBoundingClientRect();
      const dx = e.clientX - startClient[0];
      const dy = e.clientY - startClient[1];
      if (mode === 'pan') {
        state.cam.x = startCam[0] - dx / state.cam.zoom;
        state.cam.y = startCam[1] + dy / state.cam.zoom;
        drawFlowCanvas();
      } else if (mode === 'box' && state.boxSelect) {
        state.boxSelect.x1 = e.clientX - rect.left;
        state.boxSelect.y1 = e.clientY - rect.top;
        drawFlowCanvas();
      } else if (mode === 'drag-pipe-node') {
        const pipe = getActiveFlow()?.Pipes?.[state.selectedIndex];
        if (!pipe) return;
        const snap = state.gridSnap > 0 ? Math.min(32, state.gridSnap) : 0;
        let nx = dragStartPositions[0][0] + dx / state.cam.zoom;
        let ny = dragStartPositions[0][1] - dy / state.cam.zoom;
        if (snap > 0) { nx = Math.round(nx / snap) * snap; ny = Math.round(ny / snap) * snap; }
        else { nx = Math.round(nx); ny = Math.round(ny); }
        pipe.Nodes[state.selectedPipeNode] = [nx, ny];
        drawFlowCanvas();
      } else if (mode === 'drag-multi') {
        const flow = getActiveFlow();
        const snap = state.gridSnap;
        const ddx = dx / state.cam.zoom;
        const ddy = -dy / state.cam.zoom;
        for (const item of dragStartPositions) {
          let nx = item.pos[0] + ddx;
          let ny = item.pos[1] + ddy;
          if (snap > 0) { nx = Math.round(nx / snap) * snap; ny = Math.round(ny / snap) * snap; }
          else { nx = Math.round(nx); ny = Math.round(ny); }
          flow.Elements[item.i].Position = [nx, ny];
        }
        drawFlowCanvas();
      } else if (mode === 'drag-el' || mode === 'drag-deco') {
        const flow = getActiveFlow();
        const item = mode === 'drag-el' ? flow?.Elements[state.selectedIndex] : flow?.Decorations[state.selectedIndex];
        if (!item) return;
        let nx = dragStartPositions[0][0] + dx / state.cam.zoom;
        let ny = dragStartPositions[0][1] - dy / state.cam.zoom;
        if (state.gridSnap > 0) {
          nx = Math.round(nx / state.gridSnap) * state.gridSnap;
          ny = Math.round(ny / state.gridSnap) * state.gridSnap;
        } else {
          nx = Math.round(nx);
          ny = Math.round(ny);
        }
        // Smart alignment guides against other elements
        state.snapGuides = [];
        if (mode === 'drag-el') {
          const [ew, eh] = getElementSize(item);
          const thresh = Math.max(8, 10 / state.cam.zoom);
          for (let i = 0; i < (flow.Elements || []).length; i++) {
            if (i === state.selectedIndex) continue;
            const o = flow.Elements[i];
            const [ow, oh] = getElementSize(o);
            if (Math.abs(nx - o.Position[0]) <= thresh) {
              if (state.gridSnap === 0) nx = o.Position[0];
              state.snapGuides.push({ axis: 'x', val: o.Position[0] });
            } else if (Math.abs((nx + ew / 2) - (o.Position[0] + ow / 2)) <= thresh) {
              state.snapGuides.push({ axis: 'x', val: o.Position[0] + ow / 2 });
            }
            if (Math.abs(ny - o.Position[1]) <= thresh) {
              if (state.gridSnap === 0) ny = o.Position[1];
              state.snapGuides.push({ axis: 'y', val: o.Position[1] });
            } else if (Math.abs((ny - eh / 2) - (o.Position[1] - oh / 2)) <= thresh) {
              state.snapGuides.push({ axis: 'y', val: o.Position[1] - oh / 2 });
            }
            if (state.snapGuides.length >= 4) break;
          }
        }
        item.Position = [nx, ny];
        drawFlowCanvas();
      }
    });

    window.addEventListener('mouseup', () => {
      state.snapGuides = [];
      if (mode === 'box' && state.boxSelect) {
        const flow = getActiveFlow();
        const { x0, y0, x1, y1 } = state.boxSelect;
        const bx0 = Math.min(x0, x1), bx1 = Math.max(x0, x1);
        const by0 = Math.min(y0, y1), by1 = Math.max(y0, y1);
        const picked = [];
        (flow?.Elements || []).forEach((el, idx) => {
          const [ex, ey] = worldToScreen(el.Position[0], el.Position[1], canvas);
          const [ew, eh] = getElementSize(el);
          const pw = ew * state.cam.zoom;
          const ph = eh * state.cam.zoom;
          if (ex + pw >= bx0 && ex <= bx1 && ey + ph >= by0 && ey <= by1) picked.push(idx);
        });
        state.boxSelect = null;
        state.flowTool = 'select';
        state.selectedElements = picked;
        state.selectedKind = picked.length ? 'element' : null;
        state.selectedIndex = picked.length ? picked[picked.length - 1] : -1;
        mode = null;
        renderActiveTab();
        return;
      }

      if ((mode === 'drag-el' || mode === 'drag-multi' || mode === 'drag-deco' || mode === 'drag-pipe-node') && dragOriginalJson) {
        const now = JSON.stringify(state.data);
        if (now !== dragOriginalJson) {
          state.undoStack.push({ label: 'Move node', snapshot: dragOriginalJson });
          state.redoStack.length = 0;
          updateTopbarState();
          renderFlowInspector();
        }
      }
      mode = null;
      dragOriginalJson = null;
      canvas.classList.remove('dragging');
      drawFlowCanvas();
    });

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const [wxBefore, wyBefore] = screenToWorld(sx, sy, canvas);
      const factor = e.deltaY < 0 ? 1.14 : 1 / 1.14;
      state.cam.zoom = Math.max(0.08, Math.min(3.0, state.cam.zoom * factor));
      const [wxAfter, wyAfter] = screenToWorld(sx, sy, canvas);
      state.cam.x += wxBefore - wxAfter;
      state.cam.y += wyBefore - wyAfter;
      drawFlowCanvas();
    }, { passive: false });
  }

  function renderFlowInspector() {
    const body = $('flow-inspector-body');
    const delBtn = $('insp-delete');
    if (delBtn) delBtn.style.display = state.selectedKind ? 'inline-flex' : 'none';
    const flow = getActiveFlow();
    if (!body || !flow) return;

    if (!state.selectedKind || state.selectedIndex < 0) {
      body.innerHTML = `
        <div class="inspector-section">
          <h4>Flow Summary</h4>
          <div class="form-grid">
            <div class="field"><label>CameraPos X</label><input type="number" id="fl-cam-x" value="${(flow.CameraPos || [0, 0])[0]}" /></div>
            <div class="field"><label>CameraPos Y</label><input type="number" id="fl-cam-y" value="${(flow.CameraPos || [0, 0])[1]}" /></div>
            <div class="field"><label>Zoom</label><input type="number" id="fl-zoom" value="${flow.Zoom ?? 2}" /></div>
          </div>
          <div style="font-size:11.5px;color:var(--text-muted);margin-top:4px;">Click any Element, Pipe, or Decoration on the canvas or choose from the lists below:</div>
        </div>
        <div class="inspector-section">
          <h4>Elements (${(flow.Elements || []).length})</h4>
          <div style="display:flex;flex-direction:column;gap:4px;max-height:300px;overflow-y:auto;">
            ${(flow.Elements || []).map((el, i) => `
              <div class="item-chip pick-el" data-i="${i}" style="justify-content:space-between;">
                <span class="row">${spriteImg(getElementIconName(el), 18)} <strong>${esc(state.maps.elements[el.ElementType]?.Name || el.ElementType)}</strong></span>
                <span class="mono" style="font-size:10px;color:var(--text-dim);">(${(el.Position || [0, 0]).join(',')})</span>
              </div>
            `).join('')}
          </div>
        </div>
      `;
      $('fl-cam-x')?.addEventListener('change', (e) => commitChange('Edit flow camera X', (s) => {
        const fl = s.Player.Flows[state.activeFlowIndex];
        if (!fl.CameraPos) fl.CameraPos = [0, 0];
        fl.CameraPos[0] = parseInt(e.target.value, 10) || 0;
      }));
      $('fl-cam-y')?.addEventListener('change', (e) => commitChange('Edit flow camera Y', (s) => {
        const fl = s.Player.Flows[state.activeFlowIndex];
        if (!fl.CameraPos) fl.CameraPos = [0, 0];
        fl.CameraPos[1] = parseInt(e.target.value, 10) || 0;
      }));
      $('fl-zoom')?.addEventListener('change', (e) => commitChange('Edit flow zoom', (s) => {
        s.Player.Flows[state.activeFlowIndex].Zoom = parseInt(e.target.value, 10) || 2;
      }));
      body.querySelectorAll('.pick-el').forEach((c) => {
        c.addEventListener('click', () => {
          state.selectedKind = 'element';
          state.selectedIndex = parseInt(c.dataset.i, 10);
          drawFlowCanvas();
          renderFlowInspector();
        });
      });
      return;
    }

    if (state.selectedKind === 'pipe') {
      const pipe = flow.Pipes[state.selectedIndex];
      if (!pipe) return;
      body.innerHTML = `
        <div class="inspector-section">
          <h4>Pipe #${state.selectedIndex}</h4>
          <div class="row">
            <button id="pp-ortho" class="xs accent">↴ Auto-Orthogonalize</button>
            <button id="pp-clean" class="xs">Clean Collinear Nodes</button>
            <button id="pp-clear-nodes" class="xs danger">Clear Waypoints</button>
          </div>
          <div class="form-grid">
            <div class="field"><label>Output Element GUID</label><input type="text" class="mono" id="pp-out-guid" value="${esc(pipe.ConnectedOutput?.Guid || '')}" /></div>
            <div class="field"><label>Output Port Index</label><input type="number" min="0" id="pp-out-idx" value="${pipe.ConnectedOutput?.Index ?? 0}" /></div>
            <div class="field"><label>Input Element GUID</label><input type="text" class="mono" id="pp-in-guid" value="${esc(pipe.ConnectedInput?.Guid || '')}" /></div>
            <div class="field"><label>Input Port Index</label><input type="number" min="0" id="pp-in-idx" value="${pipe.ConnectedInput?.Index ?? 0}" /></div>
          </div>
          <div class="field">
            <label>Nodes (JSON array of [x, y] waypoints · drag yellow dots on canvas)</label>
            <textarea class="mono" id="pp-nodes" rows="4">${esc(JSON.stringify(pipe.Nodes || []))}</textarea>
          </div>
        </div>
      `;
      const updatePipe = (fn) => commitChange('Edit pipe', (s) => fn(s.Player.Flows[state.activeFlowIndex].Pipes[state.selectedIndex]));
      $('pp-ortho').addEventListener('click', () => updatePipe((pp) => {
        const byG = {};
        (getActiveFlow().Elements || []).forEach((el) => { byG[el.Guid] = el; });
        orthogonalizePipe(pp, byG);
      }));
      $('pp-clean').addEventListener('click', () => updatePipe((pp) => { pp.Nodes = cleanCollinearNodes(pp.Nodes || []); }));
      $('pp-clear-nodes').addEventListener('click', () => updatePipe((pp) => { pp.Nodes = []; }));
      $('pp-out-guid').addEventListener('change', (e) => updatePipe((pp) => { pp.ConnectedOutput.Guid = e.target.value; }));
      $('pp-out-idx').addEventListener('change', (e) => updatePipe((pp) => { pp.ConnectedOutput.Index = parseInt(e.target.value, 10) || 0; }));
      $('pp-in-guid').addEventListener('change', (e) => updatePipe((pp) => { pp.ConnectedInput.Guid = e.target.value; }));
      $('pp-in-idx').addEventListener('change', (e) => updatePipe((pp) => { pp.ConnectedInput.Index = parseInt(e.target.value, 10) || 0; }));
      $('pp-nodes').addEventListener('change', (e) => {
        try {
          const arr = JSON.parse(e.target.value);
          updatePipe((pp) => { pp.Nodes = arr; });
        } catch (err) { toast(`Invalid Nodes JSON: ${err.message}`, 'err'); }
      });
      return;
    }

    if (state.selectedKind === 'deco') {
      const deco = flow.Decorations[state.selectedIndex];
      if (!deco) return;
      const styles = state.catalog.enums.DecoStyles || [];
      body.innerHTML = `
        <div class="inspector-section">
          <h4>Decoration / Zone #${state.selectedIndex}</h4>
          <div class="row">
            <button id="dc-select-inside" class="xs accent">Select All Elements Inside</button>
          </div>
          <div class="form-grid">
            <div class="field"><label>Label</label><input type="text" id="dc-label" value="${esc(deco.Label || '')}" /></div>
            <div class="field">
              <label>StyleIndex</label>
              <select id="dc-style">
                ${styles.map((st) => `<option value="${st.index}" ${(deco.StyleIndex || 0) === st.index ? 'selected' : ''}>${st.index} · ${esc(st.name)}</option>`).join('')}
              </select>
            </div>
            <div class="field"><label>Pos X</label><input type="number" id="dc-px" value="${(deco.Position || [0, 0])[0]}" /></div>
            <div class="field"><label>Pos Y</label><input type="number" id="dc-py" value="${(deco.Position || [0, 0])[1]}" /></div>
            <div class="field"><label>Width</label><input type="number" id="dc-sw" value="${(deco.Size || [128, 128])[0]}" /></div>
            <div class="field"><label>Height</label><input type="number" id="dc-sh" value="${(deco.Size || [128, 128])[1]}" /></div>
          </div>
          <div class="row">
            <label class="chk"><input type="checkbox" id="dc-locked" ${deco.Locked ? 'checked' : ''} /> Locked</label>
            <label class="chk"><input type="checkbox" id="dc-parent" ${deco.IsParent ? 'checked' : ''} /> IsParent (Container)</label>
          </div>
          <div class="row">
            <button id="dc-sticker-icon" class="sm">Sticker Icon: ${esc(deco.Sticker?.IconName || 'None')}</button>
            ${deco.Sticker ? `<button id="dc-sticker-clear" class="sm danger">Clear Sticker</button>` : ''}
          </div>
        </div>
      `;
      const upd = (fn) => commitChange('Edit decoration', (s) => fn(s.Player.Flows[state.activeFlowIndex].Decorations[state.selectedIndex]));
      $('dc-select-inside').addEventListener('click', () => {
        const [dx, dy] = deco.Position || [0, 0];
        const [dw, dh] = deco.Size || [128, 128];
        const inside = [];
        (flow.Elements || []).forEach((el, i) => {
          const [ew, eh] = getElementSize(el);
          const cx = el.Position[0] + ew / 2;
          const cy = el.Position[1] - eh / 2;
          if (cx >= dx && cx <= dx + dw && cy <= dy && cy >= dy - dh) inside.push(i);
        });
        state.selectedElements = inside;
        state.selectedKind = inside.length ? 'element' : null;
        state.selectedIndex = inside.length ? inside[inside.length - 1] : -1;
        toast(`Selected ${inside.length} elements inside Deco`, 'info');
        renderActiveTab();
      });
      $('dc-label').addEventListener('change', (e) => upd((dc) => { if (e.target.value) dc.Label = e.target.value; else delete dc.Label; }));
      $('dc-style').addEventListener('change', (e) => upd((dc) => { dc.StyleIndex = parseInt(e.target.value, 10) || 0; }));
      $('dc-px').addEventListener('change', (e) => upd((dc) => { dc.Position[0] = parseInt(e.target.value, 10) || 0; }));
      $('dc-py').addEventListener('change', (e) => upd((dc) => { dc.Position[1] = parseInt(e.target.value, 10) || 0; }));
      $('dc-sw').addEventListener('change', (e) => upd((dc) => { dc.Size[0] = parseInt(e.target.value, 10) || 128; }));
      $('dc-sh').addEventListener('change', (e) => upd((dc) => { dc.Size[1] = parseInt(e.target.value, 10) || 128; }));
      $('dc-locked').addEventListener('change', (e) => upd((dc) => { if (e.target.checked) dc.Locked = true; else delete dc.Locked; }));
      $('dc-parent').addEventListener('change', (e) => upd((dc) => { if (e.target.checked) dc.IsParent = true; else delete dc.IsParent; }));
      $('dc-sticker-icon').addEventListener('click', () => {
        openIconPicker((ic) => upd((dc) => { dc.Sticker = { Type: 'IconSticker', IconName: ic }; }));
      });
      $('dc-sticker-clear')?.addEventListener('click', () => upd((dc) => { delete dc.Sticker; }));
      return;
    }

    // Element Inspector
    const el = flow.Elements[state.selectedIndex];
    if (!el) return;
    const cat = state.maps.elements[el.ElementType];
    const updEl = (label, fn) => commitChange(label, (s) => fn(s.Player.Flows[state.activeFlowIndex].Elements[state.selectedIndex]));

    // Determine specialized fields present or relevant
    const baseKeys = new Set(['Guid', 'ElementType', 'Position', 'Inputs', 'Outputs', 'Progress', 'ProductivityProgress', 'StackSize', 'Mirrored', 'Upgrades']);
    const specificKeys = Object.keys(el).filter((k) => !baseKeys.has(k));

    body.innerHTML = `
      <div class="inspector-section">
        <div class="row">
          ${spriteImg(getElementIconName(el), 30)}
          <div style="flex:1;">
            <strong style="font-size:13.5px;color:var(--gold);">${esc(cat?.Name || el.ElementType)}</strong>
            <div class="mono" style="font-size:10px;color:var(--text-dim);">${esc(el.ElementType)} · ${esc(el.Guid)}</div>
          </div>
          <button id="el-clone" class="xs accent">Clone</button>
        </div>
        <div class="form-grid">
          <div class="field"><label>Position X</label><input type="number" id="el-px" value="${(el.Position || [0, 0])[0]}" /></div>
          <div class="field"><label>Position Y</label><input type="number" id="el-py" value="${(el.Position || [0, 0])[1]}" /></div>
          <div class="field"><label>StackSize</label><input type="number" min="1" max="99" id="el-stack" value="${el.StackSize ?? 1}" /></div>
          <div class="field"><label>Progress</label><input type="number" step="0.05" id="el-prog" value="${el.Progress ?? 0}" /></div>
          <div class="field"><label>ProductivityProgress</label><input type="number" step="0.05" id="el-pprog" value="${el.ProductivityProgress ?? 0}" /></div>
          <div class="field"><label>Mirrored</label><label class="chk" style="margin-top:6px;"><input type="checkbox" id="el-mirror" ${el.Mirrored ? 'checked' : ''} /> Mirrored</label></div>
        </div>
      </div>

      <div class="inspector-section">
        <h4>
          <span>Upgrades (${(el.Upgrades || []).length} slots)</span>
          <button id="el-add-upg" class="xs accent">+ Add Slot</button>
        </h4>
        <div style="display:flex;flex-direction:column;gap:5px;">
          ${(el.Upgrades || []).map((u, ui) => {
            const utype = u?.Type || '';
            const ucat = state.maps.upgrades[utype];
            return `
              <div class="row">
                <span class="badge">#${ui}</span>
                ${ucat ? spriteImg(ucat.icon, 18) : ''}
                <select class="el-upg-sel" data-ui="${ui}" style="flex:1;">
                  <option value="">(Empty Slot)</option>
                  ${(state.catalog.flowUpgrades || []).map((fu) => `<option value="${esc(fu.id)}" ${utype === fu.id ? 'selected' : ''}>${esc(fu.name)} (${esc(fu.id)})</option>`).join('')}
                </select>
                <button class="xs danger el-upg-del" data-ui="${ui}">✕</button>
              </div>
            `;
          }).join('') || '<span style="color:var(--text-muted);font-size:11px;">No upgrade slots on element.</span>'}
        </div>
      </div>

      ${renderElementSpecificHtml(el, specificKeys)}

      <div class="inspector-section">
        <h4>
          <span>Inputs (${(el.Inputs || []).length}) &amp; Outputs (${(el.Outputs || []).length})</span>
          <div class="row">
            <button id="el-add-in" class="xs">+ In</button>
            <button id="el-add-out" class="xs">+ Out</button>
          </div>
        </h4>
        ${renderIOListHtml('Inputs', el.Inputs || [])}
        ${renderIOListHtml('Outputs', el.Outputs || [])}
      </div>

      <div class="inspector-section">
        <h4>Raw Element JSON</h4>
        <textarea id="el-raw-json" class="mono" rows="7">${esc(JSON.stringify(el, null, 2))}</textarea>
        <div class="row"><button id="el-apply-raw" class="xs accent">Apply Element JSON</button></div>
      </div>
    `;

    // Bind base fields
    $('el-px').addEventListener('change', (e) => updEl('Move element X', (x) => { x.Position[0] = parseInt(e.target.value, 10) || 0; }));
    $('el-py').addEventListener('change', (e) => updEl('Move element Y', (x) => { x.Position[1] = parseInt(e.target.value, 10) || 0; }));
    $('el-stack').addEventListener('change', (e) => updEl('Set StackSize', (x) => {
      const v = Math.max(1, parseInt(e.target.value, 10) || 1);
      if (v === 1) delete x.StackSize; else x.StackSize = v;
    }));
    $('el-prog').addEventListener('change', (e) => updEl('Set Progress', (x) => {
      const v = parseFloat(e.target.value) || 0;
      if (v === 0) delete x.Progress; else x.Progress = v;
    }));
    $('el-pprog').addEventListener('change', (e) => updEl('Set ProductivityProgress', (x) => {
      const v = parseFloat(e.target.value) || 0;
      if (v === 0) delete x.ProductivityProgress; else x.ProductivityProgress = v;
    }));
    $('el-mirror').addEventListener('change', (e) => updEl('Toggle Mirrored', (x) => {
      if (e.target.checked) x.Mirrored = true; else delete x.Mirrored;
    }));
    $('el-clone').addEventListener('click', () => {
      commitChange(`Clone ${el.ElementType}`, (s) => {
        const fl = s.Player.Flows[state.activeFlowIndex];
        const copy = deepClone(fl.Elements[state.selectedIndex]);
        copy.Guid = crypto.randomUUID ? crypto.randomUUID() : randomSeed(16);
        copy.Position = [(copy.Position[0] || 0) + 128, copy.Position[1] || 0];
        fl.Elements.push(copy);
        state.selectedIndex = fl.Elements.length - 1;
      });
    });

    // Upgrades
    $('el-add-upg').addEventListener('click', () => updEl('Add upgrade slot', (x) => {
      if (!x.Upgrades) x.Upgrades = [];
      x.Upgrades.push({ Type: 'Worker' });
    }));
    body.querySelectorAll('.el-upg-sel').forEach((sel) => {
      sel.addEventListener('change', () => updEl('Change element upgrade', (x) => {
        const ui = parseInt(sel.dataset.ui, 10);
        x.Upgrades[ui] = sel.value ? { Type: sel.value } : null;
      }));
    });
    body.querySelectorAll('.el-upg-del').forEach((btn) => {
      btn.addEventListener('click', () => updEl('Remove upgrade slot', (x) => {
        x.Upgrades.splice(parseInt(btn.dataset.ui, 10), 1);
        if (!x.Upgrades.length) delete x.Upgrades;
      }));
    });

    // Bind element-specific interactive controls
    bindElementSpecificHandlers(body, el, updEl);

    // IO Handlers
    $('el-add-in').addEventListener('click', () => updEl('Add input port', (x) => {
      if (!x.Inputs) x.Inputs = [];
      x.Inputs.push({ Position: -10, BufferedItems: [] });
    }));
    $('el-add-out').addEventListener('click', () => updEl('Add output port', (x) => {
      if (!x.Outputs) x.Outputs = [];
      x.Outputs.push({ Position: 10, BufferedItems: [] });
    }));
    body.querySelectorAll('.io-add-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        const ioKind = btn.dataset.kind;
        const ioIdx = parseInt(btn.dataset.idx, 10);
        openCatalogPicker({
          title: `Add Item to ${ioKind}[${ioIdx}]`,
          entries: Object.values(state.maps.allItems).map((it) => ({ id: it.Id, name: it.Name, icon: it.Icon, sub: it.itemClass || '' })),
          onSelect: (id) => {
            if (!id) return;
            updEl(`Add item ${id}`, (x) => {
              const arr = x[ioKind][ioIdx].BufferedItems || (x[ioKind][ioIdx].BufferedItems = []);
              arr.push(id);
            });
          },
        });
      });
    });
    body.querySelectorAll('.io-clear').forEach((btn) => {
      btn.addEventListener('click', () => updEl('Clear IO buffer', (x) => {
        x[btn.dataset.kind][parseInt(btn.dataset.idx, 10)].BufferedItems = [];
      }));
    });
    body.querySelectorAll('.io-item-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const ioKind = chip.dataset.kind;
        const ioIdx = parseInt(chip.dataset.idx, 10);
        const itemIdx = parseInt(chip.dataset.itemIdx, 10);
        openItemEditor(
          el[ioKind][ioIdx].BufferedItems[itemIdx],
          (updated) => updEl('Edit buffered item', (x) => { x[ioKind][ioIdx].BufferedItems[itemIdx] = updated; }),
          () => updEl('Delete buffered item', (x) => { x[ioKind][ioIdx].BufferedItems.splice(itemIdx, 1); })
        );
      });
    });

    $('el-apply-raw').addEventListener('click', () => {
      try {
        const parsed = JSON.parse($('el-raw-json').value);
        updEl('Apply raw element JSON', (x) => {
          for (const k of Object.keys(x)) delete x[k];
          Object.assign(x, parsed);
        });
      } catch (err) { toast(`Invalid JSON: ${err.message}`, 'err'); }
    });
  }

  function renderIOListHtml(kind, arr) {
    return arr.map((io, idx) => `
      <div style="border:1px solid var(--border);border-radius:4px;padding:6px;background:var(--bg-input);">
        <div class="row" style="margin-bottom:4px;">
          <span class="badge">${kind === 'Inputs' ? 'IN' : 'OUT'} #${idx}</span>
          <span style="font-size:11px;color:var(--text-muted);">Pos: ${io.Position ?? 0} · ${(io.BufferedItems || []).length} items</span>
          <span class="spacer"></span>
          <button class="xs accent io-add-item" data-kind="${kind}" data-idx="${idx}">+ Item</button>
          <button class="xs danger io-clear" data-kind="${kind}" data-idx="${idx}">Clear</button>
        </div>
        <div class="row">
          ${(io.BufferedItems || []).slice(0, 30).map((it, ii) => {
            const sum = getItemSummary(it);
            return `
              <div class="item-chip io-item-chip" data-kind="${kind}" data-idx="${idx}" data-item-idx="${ii}">
                ${spriteImg(sum.icon, 16)}
                <span>${esc(sum.name)}</span>
                ${sum.quality !== 1 ? `<span class="badge gold">${Math.round(sum.quality * 100)}%</span>` : ''}
              </div>
            `;
          }).join('')}
          ${(io.BufferedItems || []).length > 30 ? `<span class="badge">+${io.BufferedItems.length - 30} more</span>` : ''}
        </div>
      </div>
    `).join('');
  }

  function renderElementSpecificHtml(el, specificKeys) {
    const type = el.ElementType;
    const enums = state.catalog.enums;
    let html = '<div class="inspector-section"><h4>Element-Specific Settings</h4>';
    let handled = false;

    // RecipeElement
    if ('Recipe' in el || ['Forge', 'Blacksmith', 'Alchemist', 'Carpenter', 'Kitchen', 'Tailor', 'Leatherworker', 'Jeweler', 'Enchanter', 'Engraver', 'Scribe', 'Inventor', 'Refiner', 'SummoningCircle', 'Necromancer', 'Butcher'].includes(type)) {
      handled = true;
      const rcat = el.Recipe ? state.maps.recipes[el.Recipe] : null;
      html += `
        <div class="row">
          ${rcat ? spriteImg(rcat.Icon, 22) : ''}
          <div style="flex:1;"><strong>Recipe:</strong> <span class="mono">${esc(el.Recipe || '(None)')}</span> ${rcat ? `(${esc(rcat.Name)})` : ''}</div>
          <button id="esp-pick-recipe" class="xs accent">Pick Recipe</button>
        </div>
      `;
    }

    // Resource / SelectedResource / FilterType / Item / OutputType
    for (const key of ['Resource', 'SelectedResource', 'FilterType', 'Item', 'OutputType']) {
      if (key in el || (key === 'FilterType' && type === 'Filter') || (key === 'Resource' && type === 'Mine') || (key === 'SelectedResource' && type === 'Forest')) {
        handled = true;
        const val = el[key];
        const icat = val ? state.maps.allItems[val] : null;
        html += `
          <div class="row">
            ${icat ? spriteImg(icat.Icon, 20) : ''}
            <div style="flex:1;"><strong>${key}:</strong> <span class="mono">${esc(val || '(None)')}</span> ${icat ? `(${esc(icat.Name)})` : ''}</div>
            <button class="xs accent esp-pick-item" data-key="${key}">Pick</button>
            ${val ? `<button class="xs danger esp-clear-key" data-key="${key}">✕</button>` : ''}
          </div>
        `;
      }
    }

    // Appraiser / Accountant enums
    if ('StatAppraised' in el || type === 'Appraiser') {
      handled = true;
      html += `
        <div class="form-grid">
          <div class="field"><label>StatAppraised</label>
            <select id="esp-stat-app">
              <option value="">(None)</option>
              ${enums.AppraiserStat.map((s) => `<option value="${s}" ${el.StatAppraised === s ? 'selected' : ''}>${s}</option>`).join('')}
            </select>
          </div>
          <div class="field"><label>AppraiseType</label>
            <select id="esp-app-type">
              ${enums.AppraiserType.map((s) => `<option value="${s}" ${el.AppraiseType === s ? 'selected' : ''}>${s}</option>`).join('')}
            </select>
          </div>
          <div class="field"><label>StatAmount</label><input type="number" id="esp-stat-amt" value="${el.StatAmount ?? 0}" /></div>
        </div>
      `;
    }

    if ('CurrType' in el || type === 'Accountant') {
      handled = true;
      html += `
        <div class="form-grid">
          <div class="field"><label>CurrType</label>
            <select id="esp-curr-type">
              <option value="">(None)</option>
              ${(state.catalog.currencies || []).map((c) => `<option value="${c.Id}" ${el.CurrType === c.Id ? 'selected' : ''}>${c.Name}</option>`).join('')}
            </select>
          </div>
          <div class="field"><label>AppraiseType</label>
            <select id="esp-app-type">
              ${enums.AppraiserType.map((s) => `<option value="${s}" ${el.AppraiseType === s ? 'selected' : ''}>${s}</option>`).join('')}
            </select>
          </div>
          <div class="field"><label>CurrAmount</label><input type="number" id="esp-curr-amt" value="${el.CurrAmount ?? 0}" /></div>
        </div>
      `;
    }

    // Scalar numeric/bool/string fields
    const scalarKeys = [
      'QueuedCount', 'Capacity', 'MaxTime', 'TimeLeft', 'SwitchPosition',
      'InputCount', 'OutputCount', 'CurrentInput', 'CurrentOutput',
      'Channel', 'ChannelIndex', 'CollectedGold', 'CollectedMana',
      'CollectedCrowns', 'CollectedRequisition', 'StoredValue', 'ClickCount',
      'RewardMultiplier', 'Timeout', 'SelectedQuest', 'SelectedContract', 'WarType'
    ];
    const boolKeys = ['IsOutput', 'UseMana', 'Fighting'];

    const scalarFields = scalarKeys.filter((k) => k in el);
    const boolFields = boolKeys.filter((k) => k in el);
    if (scalarFields.length || boolFields.length) {
      handled = true;
      html += '<div class="form-grid">';
      for (const k of scalarFields) {
        const isStr = typeof el[k] === 'string';
        html += `<div class="field"><label>${k}</label><input type="${isStr ? 'text' : 'number'}" step="any" class="esp-scalar" data-key="${k}" data-str="${isStr}" value="${esc(el[k])}" /></div>`;
      }
      for (const k of boolFields) {
        html += `<div class="field"><label>${k}</label><label class="chk" style="margin-top:6px;"><input type="checkbox" class="esp-bool" data-key="${k}" ${el[k] ? 'checked' : ''} /> Enabled</label></div>`;
      }
      html += '</div>';
    }

    // Item arrays: Stockpile.Contents, WarEffort.Soldiers, QuestBoard.Contents
    for (const arrKey of ['Contents', 'Soldiers']) {
      if (Array.isArray(el[arrKey]) && (type === 'Stockpile' || type === 'WarEffort' || type === 'QuestBoard')) {
        handled = true;
        html += `
          <div class="field">
            <div class="row"><label>${arrKey} (${el[arrKey].length})</label><span class="spacer"></span><button class="xs accent esp-arr-add" data-key="${arrKey}">+ Add Item</button></div>
            <div class="row">
              ${el[arrKey].map((it, i) => {
                const sum = getItemSummary(it);
                return `<div class="item-chip esp-arr-item" data-key="${arrKey}" data-idx="${i}">${spriteImg(sum.icon, 16)} ${esc(sum.name)}${sum.quality !== 1 ? ` <span class="badge gold">${Math.round(sum.quality * 100)}%</span>` : ''}</div>`;
              }).join('')}
            </div>
          </div>
        `;
      }
    }

    // Inn / TrainingGrounds slot arrays (Contents: [{Human, Food?, TickCount, TicksRemaining}])
    if (Array.isArray(el.Contents) && (type === 'Inn' || type === 'TrainingGrounds')) {
      handled = true;
      html += `
        <div class="field">
          <label>${type} Slots (${el.Contents.length})</label>
          <div style="display:flex;flex-direction:column;gap:5px;">
            ${el.Contents.map((slot, si) => {
              if (!slot) return `<div class="badge">Slot #${si + 1}: Empty</div>`;
              const hsum = slot.Human ? getItemSummary(slot.Human) : null;
              const fsum = slot.Food ? getItemSummary(slot.Food) : null;
              return `
                <div class="row" style="background:var(--bg-input);padding:5px;border-radius:4px;border:1px solid var(--border);">
                  <span class="badge">#${si + 1}</span>
                  ${hsum ? `<div class="item-chip esp-slot-item" data-si="${si}" data-field="Human">${spriteImg(hsum.icon, 16)} ${esc(hsum.name)}</div>` : ''}
                  ${fsum ? `<div class="item-chip esp-slot-item" data-si="${si}" data-field="Food">${spriteImg(fsum.icon, 16)} ${esc(fsum.name)}</div>` : ''}
                  <span style="font-size:10.5px;color:var(--text-muted);">Ticks: ${slot.TicksRemaining ?? 0}/${slot.TickCount ?? 0}</span>
                </div>
              `;
            }).join('')}
          </div>
        </div>
      `;
    }

    // QuestBoard SelectedQuest
    if (el.SelectedQuest && typeof el.SelectedQuest === 'object') {
      handled = true;
      const qcat = state.maps.quests[el.SelectedQuest.Quest];
      html += `
        <div class="form-grid">
          <div class="field">
            <label>SelectedQuest</label>
            <select id="esp-sq-id">
              ${(state.catalog.quests || []).map((q) => `<option value="${esc(q.Id)}" ${el.SelectedQuest.Quest === q.Id ? 'selected' : ''}>${esc(q.Name)}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label>Quest TickProgress</label>
            <input type="number" step="0.5" id="esp-sq-tick" value="${el.SelectedQuest.TickProgress ?? 0}" />
          </div>
        </div>
      `;
    }

    // Dungeon CurrentDungeon
    if (el.CurrentDungeon && typeof el.CurrentDungeon === 'object') {
      handled = true;
      const cd = el.CurrentDungeon;
      html += `
        <div class="inspector-section" style="background:var(--bg-input);">
          <h4>Active Dungeon Run</h4>
          <div class="form-grid">
            <div class="field"><label>Dungeon</label>
              <select id="esp-cd-id">
                ${(state.catalog.dungeons || []).map((d) => `<option value="${esc(d.id)}" ${cd.Dungeon === d.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}
              </select>
            </div>
            <div class="field"><label>CurrentStage</label><input type="number" min="0" id="esp-cd-stage" value="${cd.CurrentStage ?? 0}" /></div>
            <div class="field"><label>StageProgress</label><input type="number" step="10" id="esp-cd-prog" value="${cd.StageProgress ?? 0}" /></div>
            <div class="field"><label>StageTick</label><input type="number" min="0" id="esp-cd-tick" value="${cd.StageTick ?? 0}" /></div>
            <div class="field"><label>Looted</label><label class="chk" style="margin-top:6px;"><input type="checkbox" id="esp-cd-loot" ${cd.Looted ? 'checked' : ''} /> Looted</label></div>
          </div>
          <div class="field">
            <label>Party (${(cd.Party || []).length})</label>
            <div class="row">
              ${(cd.Party || []).map((m, pi) => {
                const sum = getItemSummary(m);
                return `<div class="item-chip esp-cd-party" data-pi="${pi}">${spriteImg(sum.icon, 16)} ${esc(sum.name)}</div>`;
              }).join('') || '<span style="color:var(--text-muted);">No party members</span>'}
            </div>
          </div>
        </div>
      `;
    }

    // Single nested item fields: Arena Slot1/Slot2, Outfitter CurrentEquip/CurrentHuman, LastItem
    for (const itemKey of ['Slot1', 'Slot2', 'CurrentEquip', 'CurrentHuman', 'LastItem']) {
      if (el[itemKey] !== undefined && el[itemKey] !== null) {
        handled = true;
        const sum = getItemSummary(el[itemKey]);
        html += `
          <div class="row">
            <strong>${itemKey}:</strong>
            <div class="item-chip esp-single-item" data-key="${itemKey}">${spriteImg(sum.icon, 16)} ${esc(sum.name)}</div>
          </div>
        `;
      }
    }

    // Remaining / Modded unknown keys
    const handledSet = new Set([
      'Recipe', 'Resource', 'SelectedResource', 'FilterType', 'Item', 'OutputType',
      'StatAppraised', 'AppraiseType', 'StatAmount', 'CurrType', 'CurrAmount',
      'SelectedQuest', 'CurrentDungeon', 'Slot1', 'Slot2', 'CurrentEquip', 'CurrentHuman', 'LastItem',
      ...scalarKeys, ...boolKeys,
    ]);
    if (type === 'Stockpile' || type === 'WarEffort' || type === 'QuestBoard' || type === 'Inn' || type === 'TrainingGrounds') {
      handledSet.add('Contents');
      handledSet.add('Soldiers');
    }

    const remainingKeys = specificKeys.filter((k) => !handledSet.has(k));
    if (remainingKeys.length) {
      handled = true;
      for (const k of remainingKeys) {
        html += `
          <div class="field">
            <label>${esc(k)} (JSON)</label>
            <textarea class="mono esp-json-field" data-key="${esc(k)}" rows="3">${esc(JSON.stringify(el[k], null, 2))}</textarea>
          </div>
        `;
      }
    }

    if (!handled) {
      html += '<div style="font-size:11px;color:var(--text-muted);">No extra element-specific settings on this element.</div>';
    }
    html += '</div>';
    return html;
  }

  function bindElementSpecificHandlers(body, el, updEl) {
    $('esp-pick-recipe')?.addEventListener('click', () => {
      openCatalogPicker({
        title: 'Choose Recipe',
        showNone: true,
        entries: (state.catalog.recipes || []).map((r) => ({ id: r.Id, name: r.Name, icon: r.Icon, sub: r.Type || '' })),
        onSelect: (id) => updEl('Set Recipe', (x) => { if (id) x.Recipe = id; else delete x.Recipe; }),
      });
    });

    body.querySelectorAll('.esp-pick-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.key;
        openCatalogPicker({
          title: `Pick ${key}`,
          showNone: true,
          entries: Object.values(state.maps.allItems).map((it) => ({ id: it.Id, name: it.Name, icon: it.Icon, sub: it.itemClass || '' })),
          onSelect: (id) => updEl(`Set ${key}`, (x) => { if (id) x[key] = id; else delete x[key]; }),
        });
      });
    });

    body.querySelectorAll('.esp-clear-key').forEach((btn) => {
      btn.addEventListener('click', () => updEl(`Clear ${btn.dataset.key}`, (x) => { delete x[btn.dataset.key]; }));
    });

    $('esp-stat-app')?.addEventListener('change', (e) => updEl('Set StatAppraised', (x) => { if (e.target.value) x.StatAppraised = e.target.value; else delete x.StatAppraised; }));
    $('esp-curr-type')?.addEventListener('change', (e) => updEl('Set CurrType', (x) => { if (e.target.value) x.CurrType = e.target.value; else delete x.CurrType; }));
    $('esp-app-type')?.addEventListener('change', (e) => updEl('Set AppraiseType', (x) => { x.AppraiseType = e.target.value; }));
    $('esp-stat-amt')?.addEventListener('change', (e) => updEl('Set StatAmount', (x) => { x.StatAmount = parseInt(e.target.value, 10) || 0; }));
    $('esp-curr-amt')?.addEventListener('change', (e) => updEl('Set CurrAmount', (x) => { x.CurrAmount = parseInt(e.target.value, 10) || 0; }));

    body.querySelectorAll('.esp-scalar').forEach((inp) => {
      inp.addEventListener('change', () => updEl(`Set ${inp.dataset.key}`, (x) => {
        x[inp.dataset.key] = inp.dataset.str === 'true' ? inp.value : (parseFloat(inp.value) || 0);
      }));
    });
    body.querySelectorAll('.esp-bool').forEach((chk) => {
      chk.addEventListener('change', () => updEl(`Toggle ${chk.dataset.key}`, (x) => { x[chk.dataset.key] = chk.checked; }));
    });

    body.querySelectorAll('.esp-arr-add').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.key;
        openCatalogPicker({
          title: `Add to ${key}`,
          entries: Object.values(state.maps.allItems).map((it) => ({ id: it.Id, name: it.Name, icon: it.Icon })),
          onSelect: (id) => {
            if (!id) return;
            updEl(`Add to ${key}`, (x) => {
              if (!x[key]) x[key] = [];
              x[key].push(id);
            });
          },
        });
      });
    });

    body.querySelectorAll('.esp-arr-item').forEach((chip) => {
      chip.addEventListener('click', () => {
        const key = chip.dataset.key;
        const idx = parseInt(chip.dataset.idx, 10);
        openItemEditor(
          el[key][idx],
          (updated) => updEl(`Edit ${key}[${idx}]`, (x) => { x[key][idx] = updated; }),
          () => updEl(`Delete ${key}[${idx}]`, (x) => { x[key].splice(idx, 1); })
        );
      });
    });

    body.querySelectorAll('.esp-slot-item').forEach((chip) => {
      chip.addEventListener('click', () => {
        const si = parseInt(chip.dataset.si, 10);
        const field = chip.dataset.field;
        openItemEditor(
          el.Contents[si][field],
          (updated) => updEl(`Edit slot ${si} ${field}`, (x) => { x.Contents[si][field] = updated; }),
          () => updEl(`Clear slot ${si} ${field}`, (x) => { delete x.Contents[si][field]; })
        );
      });
    });

    $('esp-sq-id')?.addEventListener('change', (e) => updEl('Change SelectedQuest', (x) => { x.SelectedQuest.Quest = e.target.value; }));
    $('esp-sq-tick')?.addEventListener('change', (e) => updEl('Change Quest TickProgress', (x) => { x.SelectedQuest.TickProgress = parseFloat(e.target.value) || 0; }));

    $('esp-cd-id')?.addEventListener('change', (e) => updEl('Change Dungeon', (x) => { x.CurrentDungeon.Dungeon = e.target.value; }));
    $('esp-cd-stage')?.addEventListener('change', (e) => updEl('Change Dungeon Stage', (x) => { x.CurrentDungeon.CurrentStage = parseInt(e.target.value, 10) || 0; }));
    $('esp-cd-prog')?.addEventListener('change', (e) => updEl('Change Dungeon Progress', (x) => { x.CurrentDungeon.StageProgress = parseFloat(e.target.value) || 0; }));
    $('esp-cd-tick')?.addEventListener('change', (e) => updEl('Change Dungeon Tick', (x) => { x.CurrentDungeon.StageTick = parseInt(e.target.value, 10) || 0; }));
    $('esp-cd-loot')?.addEventListener('change', (e) => updEl('Toggle Dungeon Looted', (x) => { x.CurrentDungeon.Looted = e.target.checked; }));

    body.querySelectorAll('.esp-cd-party').forEach((chip) => {
      chip.addEventListener('click', () => {
        const pi = parseInt(chip.dataset.pi, 10);
        openItemEditor(
          el.CurrentDungeon.Party[pi],
          (updated) => updEl(`Edit Party[${pi}]`, (x) => { x.CurrentDungeon.Party[pi] = updated; }),
          () => updEl(`Remove Party[${pi}]`, (x) => { x.CurrentDungeon.Party.splice(pi, 1); })
        );
      });
    });

    body.querySelectorAll('.esp-single-item').forEach((chip) => {
      chip.addEventListener('click', () => {
        const key = chip.dataset.key;
        openItemEditor(
          el[key],
          (updated) => updEl(`Edit ${key}`, (x) => { x[key] = updated; }),
          () => updEl(`Clear ${key}`, (x) => { delete x[key]; })
        );
      });
    });

    body.querySelectorAll('.esp-json-field').forEach((ta) => {
      ta.addEventListener('change', () => {
        try {
          const val = JSON.parse(ta.value);
          updEl(`Edit ${ta.dataset.key}`, (x) => { x[ta.dataset.key] = val; });
        } catch (err) { toast(`Invalid JSON in ${ta.dataset.key}: ${err.message}`, 'err'); }
      });
    });
  }

  // --- TAB 5: Armory & Portals ---
  function renderArmoryTab(root) {
    const p = state.data.Player;
    const armory = p.Armory || Array.from({ length: 8 }, () => ({}));
    const portal = p.Portal || Array.from({ length: 64 }, () => null);
    const chColors = state.catalog.enums.ArmoryChannelColors || [];
    const curCh = armory[state.armoryChannel] || {};

    root.innerHTML = `
      <div class="card" style="margin-bottom:14px;">
        <div class="card-header">
          <span class="card-title">Armory Channels (8 Channels)</span>
          <div class="row">
            <button id="arm-add-item" class="sm accent">+ Add Item to Channel ${state.armoryChannel + 1}</button>
            <button id="arm-clear-ch" class="sm danger">Clear Channel</button>
          </div>
        </div>
        <div class="row">
          ${Array.from({ length: 8 }, (_, ch) => {
            const cnt = Object.values(armory[ch] || {}).reduce((a, arr) => a + (arr?.length || 0), 0);
            const col = chColors[ch] || '#888';
            return `
              <button class="sm ${state.armoryChannel === ch ? 'primary' : ''}" data-ach="${ch}">
                <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${col};"></span>
                Ch ${ch + 1} (${cnt})
              </button>
            `;
          }).join('')}
        </div>
        <div style="display:flex;flex-direction:column;gap:8px;margin-top:6px;">
          ${Object.entries(curCh).map(([itemId, arr]) => {
            const cat = state.maps.allItems[itemId];
            return `
              <div class="inspector-section">
                <h4>
                  <span class="row">${spriteImg(cat?.Icon, 20)} ${esc(cat?.Name || itemId)} <span class="mono" style="color:var(--text-dim);">(${esc(itemId)} · ${arr.length})</span></span>
                  <button class="xs arm-dup" data-id="${esc(itemId)}">+1 Copy</button>
                </h4>
                <div class="row">
                  ${arr.map((it, i) => {
                    const sum = getItemSummary(it);
                    return `
                      <div class="item-chip arm-item" data-id="${esc(itemId)}" data-idx="${i}">
                        ${spriteImg(sum.icon, 16)}
                        <span>#${i + 1}</span>
                        ${sum.quality !== 1 ? `<span class="badge gold">${Math.round(sum.quality * 100)}%</span>` : ''}
                      </div>
                    `;
                  }).join('')}
                </div>
              </div>
            `;
          }).join('') || '<div style="color:var(--text-muted);">This Armory channel is empty.</div>'}
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <span class="card-title">Portal Network Matrix (8 Channels × 8 Slots = 64 Buffers)</span>
        </div>
        <div class="portal-grid">
          ${portal.map((slotArr, idx) => {
            const ch = Math.floor(idx / 8);
            const slot = idx % 8;
            const cnt = Array.isArray(slotArr) ? slotArr.length : 0;
            const first = cnt > 0 ? getItemSummary(slotArr[0]) : null;
            const col = chColors[ch] || '#888';
            return `
              <div class="portal-cell ${cnt > 0 ? 'nonempty' : ''}" data-pidx="${idx}" style="border-top:3px solid ${col};">
                <div style="font-size:10px;color:var(--text-dim);">Ch${ch + 1}:${slot + 1}</div>
                ${first ? spriteImg(first.icon, 22) : '<span style="color:var(--text-dim);">—</span>'}
                <div style="font-size:10.5px;">${cnt > 0 ? `${cnt} item${cnt > 1 ? 's' : ''}` : 'Empty'}</div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;

    document.querySelectorAll('[data-ach]').forEach((b) => {
      b.addEventListener('click', () => { state.armoryChannel = parseInt(b.dataset.ach, 10); renderActiveTab(); });
    });

    $('arm-add-item')?.addEventListener('click', () => {
      openCatalogPicker({
        title: `Add Item to Armory Channel ${state.armoryChannel + 1}`,
        entries: Object.values(state.maps.allItems).map((it) => ({ id: it.Id, name: it.Name, icon: it.Icon, sub: it.itemClass || '' })),
        onSelect: (id) => {
          if (!id) return;
          commitChange(`Add ${id} to Armory`, (s) => {
            if (!s.Player.Armory) s.Player.Armory = Array.from({ length: 8 }, () => ({}));
            const chObj = s.Player.Armory[state.armoryChannel] || (s.Player.Armory[state.armoryChannel] = {});
            if (!chObj[id]) chObj[id] = [];
            chObj[id].push(id);
          });
        },
      });
    });

    $('arm-clear-ch')?.addEventListener('click', () => {
      commitChange(`Clear Armory Ch ${state.armoryChannel + 1}`, (s) => {
        if (s.Player.Armory) s.Player.Armory[state.armoryChannel] = {};
      });
    });

    document.querySelectorAll('.arm-dup').forEach((b) => {
      b.addEventListener('click', () => {
        const id = b.dataset.id;
        commitChange(`Duplicate ${id} in Armory`, (s) => {
          const arr = s.Player.Armory[state.armoryChannel][id];
          arr.push(deepClone(arr[0] || id));
        });
      });
    });

    document.querySelectorAll('.arm-item').forEach((chip) => {
      chip.addEventListener('click', () => {
        const id = chip.dataset.id;
        const idx = parseInt(chip.dataset.idx, 10);
        openItemEditor(
          curCh[id][idx],
          (updated) => commitChange('Edit Armory item', (s) => { s.Player.Armory[state.armoryChannel][id][idx] = updated; }),
          () => commitChange('Remove Armory item', (s) => {
            const arr = s.Player.Armory[state.armoryChannel][id];
            arr.splice(idx, 1);
            if (!arr.length) delete s.Player.Armory[state.armoryChannel][id];
          })
        );
      });
    });

    document.querySelectorAll('.portal-cell').forEach((cell) => {
      cell.addEventListener('click', () => {
        const pidx = parseInt(cell.dataset.pidx, 10);
        const ch = Math.floor(pidx / 8);
        const slot = pidx % 8;
        const openSlotModal = () => {
          const arr = (state.data.Player.Portal || [])[pidx] || [];
          openModal(
            `Portal Channel ${ch + 1} · Slot ${slot + 1}`,
            `
              <div class="row">
                <button id="ps-add" class="sm accent">+ Add Item</button>
                <button id="ps-clear" class="sm danger">Clear Slot</button>
              </div>
              <div class="row" style="margin-top:8px;">
                ${arr.map((it, i) => {
                  const sum = getItemSummary(it);
                  return `<div class="item-chip ps-item" data-i="${i}">${spriteImg(sum.icon, 20)} ${esc(sum.name)}</div>`;
                }).join('') || '<span style="color:var(--text-muted);">Slot is empty.</span>'}
              </div>
            `,
            [{ label: 'Close', onClick: closeModal }]
          );
          $('ps-add')?.addEventListener('click', () => {
            openCatalogPicker({
              title: 'Add Item to Portal Slot',
              entries: Object.values(state.maps.allItems).map((it) => ({ id: it.Id, name: it.Name, icon: it.Icon })),
              onSelect: (id) => {
                if (id) {
                  commitChange('Add Portal item', (s) => {
                    if (!s.Player.Portal) s.Player.Portal = Array.from({ length: 64 }, () => null);
                    if (!Array.isArray(s.Player.Portal[pidx])) s.Player.Portal[pidx] = [];
                    s.Player.Portal[pidx].push(id);
                  });
                }
                openSlotModal();
              },
            });
          });
          $('ps-clear')?.addEventListener('click', () => {
            commitChange('Clear Portal slot', (s) => { s.Player.Portal[pidx] = null; });
            openSlotModal();
          });
          document.querySelectorAll('.ps-item').forEach((chip) => {
            chip.addEventListener('click', () => {
              const ii = parseInt(chip.dataset.i, 10);
              openItemEditor(
                arr[ii],
                (updated) => { commitChange('Edit Portal item', (s) => { s.Player.Portal[pidx][ii] = updated; }); openSlotModal(); },
                () => {
                  commitChange('Remove Portal item', (s) => {
                    s.Player.Portal[pidx].splice(ii, 1);
                    if (!s.Player.Portal[pidx].length) s.Player.Portal[pidx] = null;
                  });
                  openSlotModal();
                }
              );
            });
          });
        };
        openSlotModal();
      });
    });
  }

  // --- TAB 6: Wars, Dungeons, Quests & Building Upgrades ---
  function renderAdventureTab(root) {
    const p = state.data.Player;
    const wars = state.catalog.wars || [];
    const dungeons = state.catalog.dungeons || [];
    const quests = state.catalog.quests || [];

    const warMap = {};
    for (const w of p.WarProgress || []) warMap[w.War] = w;
    const questMap = {};
    for (const q of p.QuestMeta || []) questMap[q.Quest] = q;
    const dngMap = {};
    for (const d of p.DungeonMeta || []) dngMap[d.Dungeon] = d;
    const unlockedDngs = new Set(p.UnlockedDungeons || []);

    const upgBuildingKeys = Array.from(new Set([
      ...Object.keys(p.UpgradeCounts || {}),
      ...Object.keys(p.UnlockedFlowUpgrades || {}),
    ])).sort();

    root.innerHTML = `
      <div class="grid grid-2">
        <div class="card">
          <div class="card-header">
            <span class="card-title">Wars</span>
            <button id="war-max-all" class="sm accent">Complete All Wars</button>
          </div>
          <div style="display:flex;flex-direction:column;gap:8px;">
            ${wars.map((w) => {
              const wp = warMap[w.id] || { War: w.id, CurrentStage: 0, NotifiedStage: 0, StageProgress: 0, PartialProgress: 0 };
              return `
                <div class="inspector-section">
                  <h4>
                    <span class="row">${spriteImg(w.icon, 22)} ${esc(w.name)} <span class="mono" style="color:var(--text-dim);">(${esc(w.id)})</span></span>
                    <span class="badge gold">Stage ${wp.CurrentStage} / ${w.stageCount}</span>
                  </h4>
                  <div class="form-grid">
                    <div class="field"><label>CurrentStage</label><input type="number" min="0" class="war-inp" data-war="${w.id}" data-f="CurrentStage" value="${wp.CurrentStage}" /></div>
                    <div class="field"><label>NotifiedStage</label><input type="number" min="0" class="war-inp" data-war="${w.id}" data-f="NotifiedStage" value="${wp.NotifiedStage}" /></div>
                    <div class="field"><label>StageProgress</label><input type="number" min="0" class="war-inp" data-war="${w.id}" data-f="StageProgress" value="${wp.StageProgress}" /></div>
                    <div class="field"><label>PartialProgress</label><input type="number" min="0" class="war-inp" data-war="${w.id}" data-f="PartialProgress" value="${wp.PartialProgress}" /></div>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        </div>

        <div class="card">
          <div class="card-header">
            <span class="card-title">Quests (${quests.length})</span>
            <button id="qst-bump-all" class="sm">+10 Completed All</button>
          </div>
          <table class="data-table">
            <thead><tr><th>Quest</th><th>CompletedCount</th></tr></thead>
            <tbody>
              ${quests.map((q) => {
                const cnt = questMap[q.Id]?.CompletedCount ?? 0;
                return `
                  <tr>
                    <td><div class="row">${spriteImg(q.Icon, 20)} <div><strong>${esc(q.Name)}</strong><div class="mono" style="font-size:10px;color:var(--text-dim);">${esc(q.Id)}</div></div></div></td>
                    <td><input type="number" min="0" class="qst-cnt" data-id="${esc(q.Id)}" value="${cnt}" style="width:90px;" /></td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>

      <div class="card" style="margin-top:14px;">
        <div class="card-header">
          <span class="card-title">Dungeons &amp; Stage Metadata</span>
          <button id="dng-unlock-all" class="sm accent">Unlock All Dungeons</button>
        </div>
        <div class="grid grid-2">
          ${dungeons.map((d) => {
            const isUnlocked = unlockedDngs.has(d.id);
            const meta = dngMap[d.id] || { Dungeon: d.id, CompletedCount: Array(d.stageCount).fill(0), WipeCount: Array(d.stageCount).fill(0) };
            return `
              <div class="inspector-section">
                <h4>
                  <span class="row">${spriteImg(d.icon, 22)} ${esc(d.name)} <span class="mono" style="color:var(--text-dim);">(${esc(d.id)})</span></span>
                  <label class="chk"><input type="checkbox" class="dng-unlock-chk" data-id="${esc(d.id)}" ${isUnlocked ? 'checked' : ''} /> Unlocked</label>
                </h4>
                <div style="display:grid;grid-template-columns:repeat(${meta.CompletedCount.length}, 1fr);gap:4px;">
                  ${meta.CompletedCount.map((c, si) => `
                    <div class="field">
                      <label style="font-size:10px;">S${si + 1} Cleared</label>
                      <input type="number" min="0" class="dng-comp" data-id="${esc(d.id)}" data-si="${si}" data-arr="CompletedCount" value="${c}" style="width:100%;padding:3px 4px;font-size:11px;" />
                    </div>
                  `).join('')}
                </div>
                <div style="display:grid;grid-template-columns:repeat(${meta.WipeCount.length}, 1fr);gap:4px;">
                  ${meta.WipeCount.map((w, si) => `
                    <div class="field">
                      <label style="font-size:10px;">S${si + 1} Wipes</label>
                      <input type="number" min="0" class="dng-comp" data-id="${esc(d.id)}" data-si="${si}" data-arr="WipeCount" value="${w}" style="width:100%;padding:3px 4px;font-size:11px;" />
                    </div>
                  `).join('')}
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>

      <div class="card" style="margin-top:14px;">
        <div class="card-header">
          <span class="card-title">Building Upgrade Slot Counts &amp; Unlocked Flow Upgrades</span>
          <button id="bld-add" class="sm accent">+ Add Building Type</button>
        </div>
        <table class="data-table">
          <thead><tr><th>ElementType</th><th>Upgrade Slot Count</th><th>Unlocked FlowUpgrades</th></tr></thead>
          <tbody>
            ${upgBuildingKeys.map((b) => {
              const cat = state.maps.elements[b];
              const cnt = (p.UpgradeCounts || {})[b] ?? 0;
              const unlocked = (p.UnlockedFlowUpgrades || {})[b] || [];
              return `
                <tr>
                  <td><div class="row">${spriteImg(cat?.Icon, 20)} <strong>${esc(cat?.Name || b)}</strong></div></td>
                  <td><input type="number" min="0" class="bld-slot-cnt" data-b="${esc(b)}" value="${cnt}" style="width:80px;" /></td>
                  <td>
                    <div class="row">
                      ${unlocked.map((u) => {
                        const uc = state.maps.upgrades[u];
                        return `<span class="item-chip bld-del-upg" data-b="${esc(b)}" data-u="${esc(u)}" title="Click to remove">${spriteImg(uc?.icon, 16)} ${esc(uc?.name || u)} <span class="badge red">✕</span></span>`;
                      }).join('')}
                      <button class="xs accent bld-add-upg" data-b="${esc(b)}">+ Upgrade</button>
                    </div>
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;

    document.querySelectorAll('.war-inp').forEach((inp) => {
      inp.addEventListener('change', () => {
        const wid = inp.dataset.war;
        const field = inp.dataset.f;
        commitChange(`Edit war ${wid}.${field}`, (s) => {
          if (!s.Player.WarProgress) s.Player.WarProgress = [];
          let wp = s.Player.WarProgress.find((w) => w.War === wid);
          if (!wp) {
            wp = { War: wid, CurrentStage: 0, NotifiedStage: 0, StageProgress: 0, PartialProgress: 0 };
            s.Player.WarProgress.push(wp);
          }
          wp[field] = parseInt(inp.value, 10) || 0;
        });
      });
    });

    $('war-max-all')?.addEventListener('click', () => {
      commitChange('Complete all wars', (s) => {
        s.Player.WarProgress = wars.map((w) => ({
          War: w.id, CurrentStage: w.stageCount, NotifiedStage: w.stageCount, StageProgress: 100, PartialProgress: 0,
        }));
      });
    });

    document.querySelectorAll('.qst-cnt').forEach((inp) => {
      inp.addEventListener('change', () => {
        const qid = inp.dataset.id;
        commitChange(`Set quest ${qid} count`, (s) => {
          if (!s.Player.QuestMeta) s.Player.QuestMeta = [];
          let qm = s.Player.QuestMeta.find((q) => q.Quest === qid);
          if (!qm) { qm = { Quest: qid, CompletedCount: 0 }; s.Player.QuestMeta.push(qm); }
          qm.CompletedCount = parseInt(inp.value, 10) || 0;
        });
      });
    });

    $('qst-bump-all')?.addEventListener('click', () => {
      commitChange('+10 all quests', (s) => {
        if (!s.Player.QuestMeta) s.Player.QuestMeta = [];
        for (const q of quests) {
          let qm = s.Player.QuestMeta.find((x) => x.Quest === q.Id);
          if (!qm) { qm = { Quest: q.Id, CompletedCount: 0 }; s.Player.QuestMeta.push(qm); }
          qm.CompletedCount += 10;
        }
      });
    });

    document.querySelectorAll('.dng-unlock-chk').forEach((chk) => {
      chk.addEventListener('change', () => {
        const did = chk.dataset.id;
        commitChange(`Toggle dungeon ${did}`, (s) => {
          if (!s.Player.UnlockedDungeons) s.Player.UnlockedDungeons = [];
          if (chk.checked && !s.Player.UnlockedDungeons.includes(did)) s.Player.UnlockedDungeons.push(did);
          else if (!chk.checked) s.Player.UnlockedDungeons = s.Player.UnlockedDungeons.filter((x) => x !== did);
        });
      });
    });

    $('dng-unlock-all')?.addEventListener('click', () => {
      commitChange('Unlock all dungeons', (s) => {
        s.Player.UnlockedDungeons = dungeons.map((d) => d.id);
      });
    });

    document.querySelectorAll('.dng-comp').forEach((inp) => {
      inp.addEventListener('change', () => {
        const did = inp.dataset.id;
        const si = parseInt(inp.dataset.si, 10);
        const arrName = inp.dataset.arr;
        const stageCount = state.maps.dungeons[did]?.stageCount || 8;
        commitChange(`Edit dungeon ${did} stage ${si + 1}`, (s) => {
          if (!s.Player.DungeonMeta) s.Player.DungeonMeta = [];
          let dm = s.Player.DungeonMeta.find((x) => x.Dungeon === did);
          if (!dm) {
            dm = { Dungeon: did, CompletedCount: Array(stageCount).fill(0), WipeCount: Array(stageCount).fill(0) };
            s.Player.DungeonMeta.push(dm);
          }
          dm[arrName][si] = parseInt(inp.value, 10) || 0;
        });
      });
    });

    document.querySelectorAll('.bld-slot-cnt').forEach((inp) => {
      inp.addEventListener('change', () => {
        commitChange(`Set UpgradeCounts ${inp.dataset.b}`, (s) => {
          if (!s.Player.UpgradeCounts) s.Player.UpgradeCounts = {};
          s.Player.UpgradeCounts[inp.dataset.b] = parseInt(inp.value, 10) || 0;
        });
      });
    });

    document.querySelectorAll('.bld-del-upg').forEach((chip) => {
      chip.addEventListener('click', () => {
        const { b, u } = chip.dataset;
        commitChange(`Remove ${u} from ${b}`, (s) => {
          s.Player.UnlockedFlowUpgrades[b] = (s.Player.UnlockedFlowUpgrades[b] || []).filter((x) => x !== u);
        });
      });
    });

    document.querySelectorAll('.bld-add-upg').forEach((btn) => {
      btn.addEventListener('click', () => {
        const b = btn.dataset.b;
        openCatalogPicker({
          title: `Unlock FlowUpgrade for ${b}`,
          entries: (state.catalog.flowUpgrades || []).map((u) => ({ id: u.id, name: u.name, icon: u.icon, sub: u.id })),
          onSelect: (uid) => {
            if (!uid) return;
            commitChange(`Unlock ${uid} for ${b}`, (s) => {
              if (!s.Player.UnlockedFlowUpgrades) s.Player.UnlockedFlowUpgrades = {};
              if (!s.Player.UnlockedFlowUpgrades[b]) s.Player.UnlockedFlowUpgrades[b] = [];
              if (!s.Player.UnlockedFlowUpgrades[b].includes(uid)) s.Player.UnlockedFlowUpgrades[b].push(uid);
            });
          },
        });
      });
    });

    $('bld-add')?.addEventListener('click', () => {
      openCatalogPicker({
        title: 'Add Building Type to UpgradeCounts',
        entries: (state.catalog.elements || []).map((e) => ({ id: e.Id, name: e.Name, icon: e.Icon, sub: e.Id })),
        onSelect: (bid) => {
          if (!bid) return;
          commitChange(`Add building ${bid}`, (s) => {
            if (!s.Player.UpgradeCounts) s.Player.UpgradeCounts = {};
            if (!(bid in s.Player.UpgradeCounts)) s.Player.UpgradeCounts[bid] = 1;
          });
        },
      });
    });
  }

  // --- TAB 6.5: Bloat Scanner & Cleaner ---
  function scoreCombatant(item) {
    if (!item || typeof item !== 'object') return 0;
    const st = item.Stats || {};
    const statSum = Object.values(st).reduce((a, b) => a + (Number(b) || 0), 0);
    const eqSum = (item.Equipment || []).reduce((a, eq) => {
      if (typeof eq !== 'object') return a + 10;
      return a + Object.values(eq.Stats || {}).reduce((x, y) => x + (Number(y) || 0), 0);
    }, 0);
    const q = parseTypeString(item.Type).quality || 1;
    return (statSum + eqSum) * q + (item.Level || 0) * 50;
  }

  function scanSaveBloat(data) {
    const p = data.Player || {};
    const totalBytes = JSON.stringify(data).length;
    const flows = p.Flows || [];
    const flowBreakdown = [];
    const heavyElements = [];

    let warCount = 0, warSoldiers = 0, warBytes = 0;
    let ioPorts = 0, ioItems = 0, ioBytes = 0;
    let stockpileCount = 0, stockpileItems = 0, stockpileBytes = 0;
    let orphanPipes = 0, dupPipes = 0, redundantPipeNodes = 0, pipeNodeBytesSaved = 0;
    let defaultFieldsCount = 0, noisyFloatsCount = 0;

    const countNoisyFloat = (v) => {
      if (typeof v === 'number' && !Number.isInteger(v)) {
        const s = String(v);
        if (s.length > 8) noisyFloatsCount++;
      }
    };

    const walkNoise = (obj) => {
      if (Array.isArray(obj)) {
        for (const x of obj) walkNoise(x);
      } else if (obj && typeof obj === 'object') {
        for (const v of Object.values(obj)) walkNoise(v);
      } else {
        countNoisyFloat(obj);
      }
    };
    walkNoise(p);

    flows.forEach((fl, fi) => {
      const flStr = JSON.stringify(fl);
      flowBreakdown.push({ index: fi, label: fl.Label || `Flow #${fi + 1}`, bytes: flStr.length, elements: (fl.Elements || []).length, pipes: (fl.Pipes || []).length });
      const byG = {};
      (fl.Elements || []).forEach((el, ei) => {
        byG[el.Guid] = el;
        const elStr = JSON.stringify(el);
        let itemCount = 0;

        for (const io of [...(el.Inputs || []), ...(el.Outputs || [])]) {
          ioPorts++;
          const bi = io.BufferedItems || [];
          if (bi.length > 0) {
            ioItems += bi.length;
            ioBytes += JSON.stringify(bi).length;
            itemCount += bi.length;
          }
        }
        if (el.ElementType === 'WarEffort' && Array.isArray(el.Soldiers)) {
          warCount++;
          warSoldiers += el.Soldiers.length;
          warBytes += JSON.stringify(el.Soldiers).length;
          itemCount += el.Soldiers.length;
        }
        if (el.ElementType === 'Stockpile' && Array.isArray(el.Contents)) {
          stockpileCount++;
          stockpileItems += el.Contents.length;
          stockpileBytes += JSON.stringify(el.Contents).length;
          itemCount += el.Contents.length;
        }

        if (el.Progress === 0) defaultFieldsCount++;
        if (el.ProductivityProgress === 0) defaultFieldsCount++;
        if (el.StackSize === 1) defaultFieldsCount++;
        if (el.Mirrored === false) defaultFieldsCount++;
        if (Array.isArray(el.Upgrades) && el.Upgrades.every((u) => u === null)) defaultFieldsCount++;

        if (elStr.length > 1500 || itemCount > 15) {
          heavyElements.push({
            flowIndex: fi,
            flowLabel: fl.Label || `Flow #${fi + 1}`,
            elIndex: ei,
            type: el.ElementType,
            pos: el.Position || [0, 0],
            bytes: elStr.length,
            itemCount,
          });
        }
      });

      const seen = new Set();
      for (const pp of fl.Pipes || []) {
        const og = pp.ConnectedOutput?.Guid;
        const oi = pp.ConnectedOutput?.Index ?? 0;
        const ig = pp.ConnectedInput?.Guid;
        const ii = pp.ConnectedInput?.Index ?? 0;
        const src = byG[og];
        const dst = byG[ig];
        if (!src || !dst || oi >= (src.Outputs?.length || 0) || ii >= (dst.Inputs?.length || 0)) {
          orphanPipes++;
        } else {
          const sig = `${og}:${oi}->${ig}:${ii}`;
          if (seen.has(sig)) dupPipes++;
          seen.add(sig);
        }
        if (Array.isArray(pp.Nodes) && pp.Nodes.length > 1) {
          const cleaned = cleanCollinearNodes(pp.Nodes);
          if (cleaned.length < pp.Nodes.length) {
            redundantPipeNodes += (pp.Nodes.length - cleaned.length);
            pipeNodeBytesSaved += JSON.stringify(pp.Nodes).length - JSON.stringify(cleaned).length;
          }
        }
      }
    });

    const armoryBytes = JSON.stringify(p.Armory || []).length;
    const armoryItems = (p.Armory || []).reduce((a, ch) => a + Object.values(ch || {}).reduce((x, arr) => x + (arr?.length || 0), 0), 0);
    const portalBytes = JSON.stringify(p.Portal || []).length;
    const portalItems = (p.Portal || []).reduce((a, sl) => a + (Array.isArray(sl) ? sl.length : 0), 0);

    heavyElements.sort((a, b) => b.bytes - a.bytes);
    flowBreakdown.sort((a, b) => b.bytes - a.bytes);

    return {
      totalBytes,
      format: state.format,
      warCount, warSoldiers, warBytes,
      ioPorts, ioItems, ioBytes,
      stockpileCount, stockpileItems, stockpileBytes,
      armoryItems, armoryBytes,
      portalItems, portalBytes,
      orphanPipes, dupPipes, redundantPipeNodes, pipeNodeBytesSaved,
      defaultFieldsCount, noisyFloatsCount,
      flowBreakdown,
      heavyElements: heavyElements.slice(0, 25),
    };
  }

  function applyLosslessCleanup(s) {
    const p = s.Player;
    const roundFloats = (obj) => {
      if (Array.isArray(obj)) {
        for (let i = 0; i < obj.length; i++) {
          if (typeof obj[i] === 'number' && !Number.isInteger(obj[i])) obj[i] = Math.round(obj[i] * 100000) / 100000;
          else if (obj[i] && typeof obj[i] === 'object') roundFloats(obj[i]);
        }
      } else if (obj && typeof obj === 'object') {
        for (const k of Object.keys(obj)) {
          if (typeof obj[k] === 'number' && !Number.isInteger(obj[k])) obj[k] = Math.round(obj[k] * 100000) / 100000;
          else if (obj[k] && typeof obj[k] === 'object') roundFloats(obj[k]);
        }
      }
    };
    roundFloats(p);

    if (p.NewTechCount) {
      for (const k of Object.keys(p.NewTechCount)) {
        if (!p.NewTechCount[k]) delete p.NewTechCount[k];
      }
    }

    for (const fl of p.Flows || []) {
      const byG = {};
      for (const el of fl.Elements || []) {
        byG[el.Guid] = el;
        if (el.Progress === 0) delete el.Progress;
        if (el.ProductivityProgress === 0) delete el.ProductivityProgress;
        if (el.StackSize === 1) delete el.StackSize;
        if (el.Mirrored === false) delete el.Mirrored;
        if (Array.isArray(el.Upgrades) && el.Upgrades.every((u) => u === null)) delete el.Upgrades;
      }
      const seen = new Set();
      fl.Pipes = (fl.Pipes || []).filter((pp) => {
        const og = pp.ConnectedOutput?.Guid;
        const oi = pp.ConnectedOutput?.Index ?? 0;
        const ig = pp.ConnectedInput?.Guid;
        const ii = pp.ConnectedInput?.Index ?? 0;
        const src = byG[og];
        const dst = byG[ig];
        if (!src || !dst || oi >= (src.Outputs?.length || 0) || ii >= (dst.Inputs?.length || 0)) return false;
        const sig = `${og}:${oi}->${ig}:${ii}`;
        if (seen.has(sig)) return false;
        seen.add(sig);
        if (Array.isArray(pp.Nodes)) pp.Nodes = cleanCollinearNodes(pp.Nodes);
        return true;
      });
    }
  }

  function renderCleanerTab(root) {
    const scan = scanSaveBloat(state.data);
    const opts = state.cleanerOpts;

    root.innerHTML = `
      <div class="card" style="margin-bottom:14px;">
        <div class="card-header">
          <span class="card-title">🧹 Save Size &amp; Bloat Scanner — ${formatBytes(scan.totalBytes)} JSON</span>
          <div class="row">
            <button id="cl-run-lossless" class="sm accent">Run Safe Lossless Cleanup</button>
            <button id="cl-run-all" class="sm primary">Clean All Selected Bloat</button>
          </div>
        </div>
        <div class="row" style="font-size:12px;color:var(--text-muted);">
          <span>Save Format: <strong style="color:${scan.format === 'compressed' ? 'var(--green)' : 'var(--gold)'};">${esc(scan.format)}</strong></span>
          ${scan.format !== 'compressed' ? `<button id="cl-switch-gzip" class="xs gold">Switch Output Format to GZip (.save) (~90% smaller on disk)</button>` : ''}
        </div>
        <div class="grid grid-4">
          <div class="bloat-stat-card">
            <div class="row"><strong>⚔ WarEffort Soldiers</strong><span class="spacer"></span><span class="badge ${scan.warBytes > 200000 ? 'red' : 'gold'}">${formatBytes(scan.warBytes)}</span></div>
            <div style="font-size:11.5px;color:var(--text-muted);">${scan.warSoldiers.toLocaleString()} soldiers across ${scan.warCount} WarEffort(s)</div>
            <div class="row">
              <label style="font-size:11px;">Keep Top:</label>
              <input type="number" min="0" id="cl-war-keep" value="${opts.warKeep}" style="width:65px;" />
              <button id="cl-trim-war" class="xs accent">Trim</button>
              <button id="cl-clear-war" class="xs danger">Clear All</button>
            </div>
          </div>

          <div class="bloat-stat-card">
            <div class="row"><strong>📦 IO BufferedItems</strong><span class="spacer"></span><span class="badge ${scan.ioBytes > 500000 ? 'red' : 'gold'}">${formatBytes(scan.ioBytes)}</span></div>
            <div style="font-size:11.5px;color:var(--text-muted);">${scan.ioItems.toLocaleString()} items across ${scan.ioPorts.toLocaleString()} IO ports</div>
            <div class="row">
              <label style="font-size:11px;">Max/Port:</label>
              <input type="number" min="0" id="cl-io-keep" value="${opts.ioKeep}" style="width:65px;" />
              <button id="cl-trim-io" class="xs accent">Trim</button>
              <button id="cl-clear-io" class="xs danger">Flush All</button>
            </div>
          </div>

          <div class="bloat-stat-card">
            <div class="row"><strong>🏛 Stockpiles</strong><span class="spacer"></span><span class="badge ${scan.stockpileBytes > 200000 ? 'red' : 'gold'}">${formatBytes(scan.stockpileBytes)}</span></div>
            <div style="font-size:11.5px;color:var(--text-muted);">${scan.stockpileItems.toLocaleString()} items across ${scan.stockpileCount} Stockpile(s)</div>
            <div class="row">
              <label style="font-size:11px;">Max/Box:</label>
              <input type="number" min="0" id="cl-sp-keep" value="${opts.stockpileKeep}" style="width:65px;" />
              <button id="cl-trim-sp" class="xs accent">Trim</button>
              <button id="cl-clear-sp" class="xs danger">Empty</button>
            </div>
          </div>

          <div class="bloat-stat-card">
            <div class="row"><strong>🛡 Armory &amp; Portals</strong><span class="spacer"></span><span class="badge accent">${formatBytes(scan.armoryBytes + scan.portalBytes)}</span></div>
            <div style="font-size:11.5px;color:var(--text-muted);">Armory: ${scan.armoryItems} items · Portals: ${scan.portalItems} items</div>
            <div class="row">
              <label style="font-size:11px;">Armory Cap:</label>
              <input type="number" min="0" id="cl-arm-keep" value="${opts.armoryKeep}" style="width:65px;" />
              <button id="cl-trim-arm" class="xs accent">Trim</button>
              <button id="cl-clear-portal" class="xs danger">Clear Portals</button>
            </div>
          </div>
        </div>

        <div class="inspector-section">
          <h4>Lossless Structural Cleanup (Zero Items Lost)</h4>
          <div class="row">
            <span class="badge ${scan.orphanPipes > 0 ? 'red' : 'green'}">Orphaned Pipes: ${scan.orphanPipes}</span>
            <span class="badge ${scan.dupPipes > 0 ? 'red' : 'green'}">Duplicate Pipes: ${scan.dupPipes}</span>
            <span class="badge ${scan.redundantPipeNodes > 0 ? 'gold' : 'green'}">Redundant Pipe Waypoints: ${scan.redundantPipeNodes}</span>
            <span class="badge ${scan.defaultFieldsCount > 0 ? 'gold' : 'green'}">Redundant Default Fields: ${scan.defaultFieldsCount}</span>
            <span class="badge ${scan.noisyFloatsCount > 0 ? 'gold' : 'green'}">Verbose 15-Digit Floats: ${scan.noisyFloatsCount.toLocaleString()}</span>
          </div>
        </div>
      </div>

      <div class="grid grid-2">
        <div class="card">
          <div class="card-header"><span class="card-title">Flow Size Breakdown</span></div>
          <table class="data-table">
            <thead><tr><th>Flow</th><th>Elements</th><th>Pipes</th><th>JSON Size</th><th>Share</th></tr></thead>
            <tbody>
              ${scan.flowBreakdown.map((f) => `
                <tr>
                  <td><strong>${esc(f.label)}</strong></td>
                  <td>${f.elements}</td>
                  <td>${f.pipes}</td>
                  <td class="mono">${formatBytes(f.bytes)}</td>
                  <td>${((f.bytes / Math.max(1, scan.totalBytes)) * 100).toFixed(1)}%</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>

        <div class="card">
          <div class="card-header"><span class="card-title">Top 25 Largest Elements</span></div>
          <div style="max-height:420px;overflow-y:auto;">
            <table class="data-table">
              <thead><tr><th>Flow</th><th>Type</th><th>Items</th><th>Size</th><th>Actions</th></tr></thead>
              <tbody>
                ${scan.heavyElements.map((he) => `
                  <tr>
                    <td>${esc(he.flowLabel)}</td>
                    <td><strong>${esc(he.type)}</strong> <span class="mono" style="font-size:10px;color:var(--text-dim);">(${he.pos.join(',')})</span></td>
                    <td>${he.itemCount}</td>
                    <td class="mono">${formatBytes(he.bytes)}</td>
                    <td>
                      <div class="row">
                        <button class="xs accent cl-jump" data-fi="${he.flowIndex}" data-ei="${he.elIndex}">Inspect</button>
                        <button class="xs danger cl-clear-el" data-fi="${he.flowIndex}" data-ei="${he.elIndex}">Clear Items</button>
                      </div>
                    </td>
                  </tr>
                `).join('') || '<tr><td colspan="5" style="color:var(--text-muted);">No bloated elements found!</td></tr>'}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `;

    $('cl-war-keep')?.addEventListener('change', (e) => { opts.warKeep = Math.max(0, parseInt(e.target.value, 10) || 0); });
    $('cl-io-keep')?.addEventListener('change', (e) => { opts.ioKeep = Math.max(0, parseInt(e.target.value, 10) || 0); });
    $('cl-sp-keep')?.addEventListener('change', (e) => { opts.stockpileKeep = Math.max(0, parseInt(e.target.value, 10) || 0); });
    $('cl-arm-keep')?.addEventListener('change', (e) => { opts.armoryKeep = Math.max(0, parseInt(e.target.value, 10) || 0); });

    $('cl-switch-gzip')?.addEventListener('click', () => {
      $('save-format-select').value = 'compressed';
      state.format = 'compressed';
      updateTopbarState();
      renderActiveTab();
      toast('Output format set to GZip compressed (.save)', 'ok');
    });

    const reportSaved = (beforeBytes, label) => {
      const afterBytes = JSON.stringify(state.data).length;
      const saved = beforeBytes - afterBytes;
      toast(`${label}: ${formatBytes(beforeBytes)} → ${formatBytes(afterBytes)} (saved ${formatBytes(saved)})`, 'ok');
    };

    const trimWar = (keep) => {
      const before = JSON.stringify(state.data).length;
      commitChange(`Trim WarEffort soldiers to ${keep}`, (s) => {
        for (const fl of s.Player.Flows || []) {
          for (const el of fl.Elements || []) {
            if (el.ElementType === 'WarEffort' && Array.isArray(el.Soldiers) && el.Soldiers.length > keep) {
              if (keep === 0) el.Soldiers = [];
              else {
                el.Soldiers.sort((a, b) => scoreCombatant(b) - scoreCombatant(a));
                el.Soldiers = el.Soldiers.slice(0, keep);
              }
            }
          }
        }
      });
      reportSaved(before, 'WarEffort trim');
    };

    const trimIO = (keep) => {
      const before = JSON.stringify(state.data).length;
      commitChange(`Trim IO buffers to ${keep}`, (s) => {
        for (const fl of s.Player.Flows || []) {
          for (const el of fl.Elements || []) {
            for (const io of [...(el.Inputs || []), ...(el.Outputs || [])]) {
              if (Array.isArray(io.BufferedItems) && io.BufferedItems.length > keep) {
                io.BufferedItems = keep === 0 ? [] : io.BufferedItems.slice(0, keep);
              }
            }
          }
        }
      });
      reportSaved(before, 'IO buffer trim');
    };

    const trimStockpile = (keep) => {
      const before = JSON.stringify(state.data).length;
      commitChange(`Trim Stockpiles to ${keep}`, (s) => {
        for (const fl of s.Player.Flows || []) {
          for (const el of fl.Elements || []) {
            if (el.ElementType === 'Stockpile' && Array.isArray(el.Contents) && el.Contents.length > keep) {
              el.Contents = keep === 0 ? [] : el.Contents.slice(0, keep);
            }
          }
        }
      });
      reportSaved(before, 'Stockpile trim');
    };

    const trimArmory = (keep) => {
      const before = JSON.stringify(state.data).length;
      commitChange(`Cap Armory to ${keep}/type`, (s) => {
        for (const ch of s.Player.Armory || []) {
          if (!ch || typeof ch !== 'object') continue;
          for (const k of Object.keys(ch)) {
            if (Array.isArray(ch[k]) && ch[k].length > keep) {
              if (keep === 0) delete ch[k];
              else ch[k] = ch[k].slice(0, keep);
            }
          }
        }
      });
      reportSaved(before, 'Armory trim');
    };

    $('cl-trim-war')?.addEventListener('click', () => trimWar(opts.warKeep));
    $('cl-clear-war')?.addEventListener('click', () => trimWar(0));
    $('cl-trim-io')?.addEventListener('click', () => trimIO(opts.ioKeep));
    $('cl-clear-io')?.addEventListener('click', () => trimIO(0));
    $('cl-trim-sp')?.addEventListener('click', () => trimStockpile(opts.stockpileKeep));
    $('cl-clear-sp')?.addEventListener('click', () => trimStockpile(0));
    $('cl-trim-arm')?.addEventListener('click', () => trimArmory(opts.armoryKeep));
    $('cl-clear-portal')?.addEventListener('click', () => {
      const before = JSON.stringify(state.data).length;
      commitChange('Clear all Portal slots', (s) => { s.Player.Portal = Array.from({ length: 64 }, () => null); });
      reportSaved(before, 'Cleared Portals');
    });

    $('cl-run-lossless')?.addEventListener('click', () => {
      const before = JSON.stringify(state.data).length;
      commitChange('Run safe lossless cleanup', applyLosslessCleanup);
      reportSaved(before, 'Lossless cleanup');
    });

    $('cl-run-all')?.addEventListener('click', () => {
      const before = JSON.stringify(state.data).length;
      commitChange('Clean all selected bloat', (s) => {
        applyLosslessCleanup(s);
        for (const fl of s.Player.Flows || []) {
          for (const el of fl.Elements || []) {
            if (el.ElementType === 'WarEffort' && Array.isArray(el.Soldiers) && el.Soldiers.length > opts.warKeep) {
              el.Soldiers.sort((a, b) => scoreCombatant(b) - scoreCombatant(a));
              el.Soldiers = opts.warKeep === 0 ? [] : el.Soldiers.slice(0, opts.warKeep);
            }
            if (el.ElementType === 'Stockpile' && Array.isArray(el.Contents) && el.Contents.length > opts.stockpileKeep) {
              el.Contents = opts.stockpileKeep === 0 ? [] : el.Contents.slice(0, opts.stockpileKeep);
            }
            for (const io of [...(el.Inputs || []), ...(el.Outputs || [])]) {
              if (Array.isArray(io.BufferedItems) && io.BufferedItems.length > opts.ioKeep) {
                io.BufferedItems = opts.ioKeep === 0 ? [] : io.BufferedItems.slice(0, opts.ioKeep);
              }
            }
          }
        }
        for (const ch of s.Player.Armory || []) {
          if (!ch || typeof ch !== 'object') continue;
          for (const k of Object.keys(ch)) {
            if (Array.isArray(ch[k]) && ch[k].length > opts.armoryKeep) {
              if (opts.armoryKeep === 0) delete ch[k];
              else ch[k] = ch[k].slice(0, opts.armoryKeep);
            }
          }
        }
      });
      reportSaved(before, 'Full bloat cleanup');
    });

    document.querySelectorAll('.cl-jump').forEach((btn) => {
      btn.addEventListener('click', () => {
        const fi = parseInt(btn.dataset.fi, 10);
        const ei = parseInt(btn.dataset.ei, 10);
        state.activeFlowIndex = fi;
        state.selectedKind = 'element';
        state.selectedIndex = ei;
        state.selectedElements = [];
        const el = state.data.Player.Flows[fi].Elements[ei];
        const [ew, eh] = getElementSize(el);
        state.cam = { x: el.Position[0] + ew / 2, y: el.Position[1] - eh / 2, zoom: 0.9 };
        switchTab('flows');
      });
    });

    document.querySelectorAll('.cl-clear-el').forEach((btn) => {
      btn.addEventListener('click', () => {
        const fi = parseInt(btn.dataset.fi, 10);
        const ei = parseInt(btn.dataset.ei, 10);
        commitChange('Clear element buffered items', (s) => {
          const el = s.Player.Flows[fi].Elements[ei];
          for (const io of [...(el.Inputs || []), ...(el.Outputs || [])]) io.BufferedItems = [];
          if (Array.isArray(el.Soldiers)) el.Soldiers = [];
          if (Array.isArray(el.Contents)) el.Contents = [];
        });
      });
    });
  }

  // --- TAB 7: Register & Raw JSON ---
  function renderRawTab(root) {
    const reg = state.data.Player.Register || { Flags: {}, Counters: {}, Data: {} };
    root.innerHTML = `
      <div class="grid grid-3" style="margin-bottom:14px;">
        <div class="card">
          <div class="card-header">
            <span class="card-title">Register Flags (${Object.keys(reg.Flags || {}).length})</span>
            <button id="reg-add-flag" class="xs accent">+ Flag</button>
          </div>
          <div style="display:flex;flex-direction:column;gap:6px;">
            ${Object.entries(reg.Flags || {}).map(([k, v]) => `
              <div class="row">
                <span class="mono" style="flex:1;font-size:11.5px;">${esc(k)}</span>
                <label class="chk"><input type="checkbox" class="reg-flag-chk" data-k="${esc(k)}" ${v ? 'checked' : ''} /> ${v}</label>
                <button class="xs danger reg-del" data-sec="Flags" data-k="${esc(k)}">✕</button>
              </div>
            `).join('') || '<span style="color:var(--text-muted);">No flags</span>'}
          </div>
        </div>

        <div class="card">
          <div class="card-header">
            <span class="card-title">Register Counters (${Object.keys(reg.Counters || {}).length})</span>
            <button id="reg-add-cnt" class="xs accent">+ Counter</button>
          </div>
          <div style="display:flex;flex-direction:column;gap:6px;">
            ${Object.entries(reg.Counters || {}).map(([k, v]) => `
              <div class="row">
                <span class="mono" style="flex:1;font-size:11.5px;">${esc(k)}</span>
                <input type="number" class="reg-cnt-inp" data-k="${esc(k)}" value="${v}" style="width:90px;" />
                <button class="xs danger reg-del" data-sec="Counters" data-k="${esc(k)}">✕</button>
              </div>
            `).join('') || '<span style="color:var(--text-muted);">No counters</span>'}
          </div>
        </div>

        <div class="card">
          <div class="card-header">
            <span class="card-title">Register Data (${Object.keys(reg.Data || {}).length})</span>
            <button id="reg-add-data" class="xs accent">+ Data</button>
          </div>
          <div style="display:flex;flex-direction:column;gap:6px;">
            ${Object.entries(reg.Data || {}).map(([k, v]) => `
              <div class="row">
                <span class="mono" style="flex:1;font-size:11.5px;">${esc(k)}</span>
                <input type="text" class="reg-data-inp" data-k="${esc(k)}" value="${esc(v)}" style="width:120px;" />
                <button class="xs danger reg-del" data-sec="Data" data-k="${esc(k)}">✕</button>
              </div>
            `).join('') || '<span style="color:var(--text-muted);">No data entries</span>'}
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <span class="card-title">Full Raw Save JSON</span>
          <div class="row">
            <button id="raw-format" class="sm">Prettify</button>
            <button id="raw-copy" class="sm">Copy JSON</button>
            <button id="raw-apply" class="sm primary">Apply Raw JSON Changes</button>
          </div>
        </div>
        <textarea id="raw-editor" class="mono" rows="24" style="width:100%;font-size:11.5px;">${esc(JSON.stringify(state.data, null, 2))}</textarea>
      </div>
    `;

    const ensureReg = (s) => {
      if (!s.Player.Register) s.Player.Register = { Flags: {}, Counters: {}, Data: {} };
      if (!s.Player.Register.Flags) s.Player.Register.Flags = {};
      if (!s.Player.Register.Counters) s.Player.Register.Counters = {};
      if (!s.Player.Register.Data) s.Player.Register.Data = {};
    };

    document.querySelectorAll('.reg-flag-chk').forEach((chk) => {
      chk.addEventListener('change', () => commitChange(`Set Flag ${chk.dataset.k}`, (s) => { ensureReg(s); s.Player.Register.Flags[chk.dataset.k] = chk.checked; }));
    });
    document.querySelectorAll('.reg-cnt-inp').forEach((inp) => {
      inp.addEventListener('change', () => commitChange(`Set Counter ${inp.dataset.k}`, (s) => { ensureReg(s); s.Player.Register.Counters[inp.dataset.k] = parseInt(inp.value, 10) || 0; }));
    });
    document.querySelectorAll('.reg-data-inp').forEach((inp) => {
      inp.addEventListener('change', () => commitChange(`Set Data ${inp.dataset.k}`, (s) => { ensureReg(s); s.Player.Register.Data[inp.dataset.k] = inp.value; }));
    });
    document.querySelectorAll('.reg-del').forEach((btn) => {
      btn.addEventListener('click', () => commitChange(`Delete Register.${btn.dataset.sec}.${btn.dataset.k}`, (s) => {
        ensureReg(s);
        delete s.Player.Register[btn.dataset.sec][btn.dataset.k];
      }));
    });

    $('reg-add-flag')?.addEventListener('click', () => {
      const k = prompt('Flag key:');
      if (k) commitChange(`Add Flag ${k}`, (s) => { ensureReg(s); s.Player.Register.Flags[k] = true; });
    });
    $('reg-add-cnt')?.addEventListener('click', () => {
      const k = prompt('Counter key:');
      if (k) commitChange(`Add Counter ${k}`, (s) => { ensureReg(s); s.Player.Register.Counters[k] = 1; });
    });
    $('reg-add-data')?.addEventListener('click', () => {
      const k = prompt('Data key:');
      if (!k) return;
      const v = prompt('Data value:') ?? '';
      commitChange(`Add Data ${k}`, (s) => { ensureReg(s); s.Player.Register.Data[k] = v; });
    });

    $('raw-format')?.addEventListener('click', () => {
      try {
        $('raw-editor').value = JSON.stringify(JSON.parse($('raw-editor').value), null, 2);
      } catch (err) { toast(`Invalid JSON: ${err.message}`, 'err'); }
    });
    $('raw-copy')?.addEventListener('click', async () => {
      await navigator.clipboard.writeText($('raw-editor').value);
      toast('Copied full JSON to clipboard', 'ok');
    });
    $('raw-apply')?.addEventListener('click', () => {
      try {
        const parsed = JSON.parse($('raw-editor').value);
        if (!parsed.Player) throw new Error('Missing top-level "Player" object');
        commitChange('Apply Raw JSON', (s) => {
          for (const k of Object.keys(s)) delete s[k];
          Object.assign(s, parsed);
        });
        toast('Applied raw JSON changes', 'ok');
      } catch (err) { toast(`Invalid JSON: ${err.message}`, 'err'); }
    });
  }

  // --- Diff & Backups Modals ---
  function showDiffModal() {
    if (!state.data) return;
    const orig = JSON.parse(state.originalJsonStr);
    const diffs = [];
    const walk = (a, b, path) => {
      if (a === b) return;
      if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') {
        diffs.push(`~ ${path}: ${JSON.stringify(a)}  -->  ${JSON.stringify(b)}`);
        return;
      }
      if (Array.isArray(a) && Array.isArray(b)) {
        if (JSON.stringify(a) !== JSON.stringify(b)) {
          if (a.length !== b.length) diffs.push(`~ ${path}: array length ${a.length} --> ${b.length}`);
          const len = Math.min(a.length, b.length, 40);
          for (let i = 0; i < len; i++) {
            if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) {
              if (typeof a[i] === 'object' || typeof b[i] === 'object') walk(a[i], b[i], `${path}[${i}]`);
              else diffs.push(`~ ${path}[${i}]: ${JSON.stringify(a[i])} --> ${JSON.stringify(b[i])}`);
            }
          }
          if (b.length > a.length) diffs.push(`+ ${path}[${a.length}..${b.length - 1}] added (${b.length - a.length} items)`);
          if (a.length > b.length) diffs.push(`- ${path}[${b.length}..${a.length - 1}] removed (${a.length - b.length} items)`);
        }
        return;
      }
      const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
      for (const k of keys) {
        if (!(k in a)) diffs.push(`+ ${path}.${k}: ${JSON.stringify(b[k]).slice(0, 140)}`);
        else if (!(k in b)) diffs.push(`- ${path}.${k}: ${JSON.stringify(a[k]).slice(0, 140)}`);
        else walk(a[k], b[k], `${path}.${k}`);
      }
    };
    walk(orig, state.data, 'Root');

    const html = diffs.length
      ? `<div class="diff-box">${diffs.slice(0, 500).map((line) => {
          const cls = line.startsWith('+') ? 'diff-add' : line.startsWith('-') ? 'diff-del' : 'diff-chg';
          return `<div class="${cls}">${esc(line)}</div>`;
        }).join('')}${diffs.length > 500 ? `<div>...and ${diffs.length - 500} more changes</div>` : ''}</div>`
      : '<div style="color:var(--text-muted);">No pending changes compared to disk.</div>';

    openModal('Pending Changes Diff', html, [{ label: 'Close', onClick: closeModal }], true);
  }

  async function showBackupsModal() {
    if (!state.currentPath) return;
    try {
      const res = await api(`/api/backups?path=${encodeURIComponent(state.currentPath)}`);
      const list = res.backups || [];
      openModal(
        `Backups for ${esc(state.currentName)}`,
        list.length
          ? `<table class="data-table">
              <thead><tr><th>Backup File</th><th>Timestamp</th><th>Size</th><th></th></tr></thead>
              <tbody>
                ${list.map((b) => `
                  <tr>
                    <td class="mono">${esc(b.name)}</td>
                    <td>${esc(b.mtimeIso)}</td>
                    <td>${formatBytes(b.size)}</td>
                    <td><button class="xs accent restore-bak" data-bpath="${esc(b.path)}">Restore</button></td>
                  </tr>
                `).join('')}
              </tbody>
            </table>`
          : '<div style="color:var(--text-muted);">No backups yet for this save file.</div>',
        [{ label: 'Close', onClick: closeModal }],
        true
      );
      document.querySelectorAll('.restore-bak').forEach((btn) => {
        btn.addEventListener('click', async () => {
          if (!confirm('Restore this backup? Current file will be backed up first.')) return;
          try {
            const r = await api('/api/backup/restore', 'POST', {
              backupPath: btn.dataset.bpath,
              targetPath: state.currentPath,
            });
            closeModal();
            applyLoadedSave(r);
            refreshSavesList();
            toast('Backup restored!', 'ok');
          } catch (err) { toast(`Restore failed: ${err.message}`, 'err'); }
        });
      });
    } catch (err) { toast(`Failed to load backups: ${err.message}`, 'err'); }
  }

  // --- Boot & Event Wiring ---
  async function init() {
    try {
      state.catalog = await api('/api/catalog');
      buildCatalogMaps(state.catalog);
      await refreshSavesList();
    } catch (err) {
      toast(`Initialization error: ${err.message}`, 'err');
    }

    $('btn-toggle-sidebar').addEventListener('click', () => {
      $('saves-sidebar').classList.toggle('collapsed');
      setTimeout(drawFlowCanvas, 180);
    });
    $('btn-refresh-saves').addEventListener('click', refreshSavesList);
    $('saves-dir-input').addEventListener('change', refreshSavesList);
    $('saves-filter-input').addEventListener('input', (e) => {
      state.savesFilter = e.target.value;
      renderSavesList();
    });

    $('btn-undo').addEventListener('click', undo);
    $('btn-redo').addEventListener('click', redo);
    $('btn-scan-bloat').addEventListener('click', () => switchTab('cleaner'));
    $('btn-diff').addEventListener('click', showDiffModal);
    $('btn-backups').addEventListener('click', showBackupsModal);
    $('btn-save').addEventListener('click', saveCurrentFile);
    $('btn-save-as').addEventListener('click', saveAsFile);
    $('btn-export').addEventListener('click', exportCurrentSave);

    $('file-upload-input').addEventListener('change', (e) => {
      if (e.target.files[0]) handleFileUpload(e.target.files[0]);
      e.target.value = '';
    });

    // Drag and drop anywhere
    window.addEventListener('dragover', (e) => {
      e.preventDefault();
      $('drop-overlay').classList.add('visible');
    });
    window.addEventListener('dragleave', (e) => {
      if (e.relatedTarget === null) $('drop-overlay').classList.remove('visible');
    });
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      $('drop-overlay').classList.remove('visible');
      if (e.dataTransfer.files[0]) handleFileUpload(e.dataTransfer.files[0]);
    });

    // Tabs
    $('tabs-bar').querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        $('tabs-bar').querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        state.activeTab = btn.dataset.tab;
        renderActiveTab();
      });
    });

    // Modal close
    $('modal-close').addEventListener('click', closeModal);
    $('modal-backdrop').addEventListener('click', (e) => {
      if (e.target === $('modal-backdrop')) closeModal();
    });

    // Keyboard shortcuts
    window.addEventListener('keydown', (e) => {
      const tag = document.activeElement?.tagName;
      const editingText = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      if (e.ctrlKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        saveCurrentFile();
      } else if (e.ctrlKey && e.key.toLowerCase() === 'z' && !editingText) {
        e.preventDefault();
        undo();
      } else if (e.ctrlKey && e.key.toLowerCase() === 'y' && !editingText) {
        e.preventDefault();
        redo();
      } else if (e.key === 'Delete' && !editingText && state.activeTab === 'flows' && state.selectedKind) {
        deleteSelectedFlowItem();
      } else if (e.key === 'Escape') {
        if ($('modal-backdrop').classList.contains('open')) closeModal();
        else if (state.connectStart) { state.connectStart = null; state.flowTool = 'select'; renderActiveTab(); }
      }
    });

    window.addEventListener('resize', () => {
      if (state.activeTab === 'flows') drawFlowCanvas();
    });
  }

  init();
})();
