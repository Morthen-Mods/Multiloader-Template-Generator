/* app.js - UI glue for index.html. Generation logic lives in generator.js, version lists in versions.js. */
(function () {
  'use strict';

  // One template snapshot per Minecraft version line (see scripts/bake.py). Exactly the one
  // the selected Minecraft version needs is fetched, so a visit downloads a single template.
  const MANIFEST = window.TEMPLATE_MANIFEST;
  window.TEMPLATE_SNAPSHOTS = window.TEMPLATE_SNAPSHOTS || {};   // each snapshot file fills this in
  let entry = null;        // manifest entry currently in use
  let TD = null;           // its snapshot
  let defaults = null;     // ModGen.uiDefaults(TD)

  // "auto" fields follow their source until the user edits them: derived names, Java, and every version
  // field (which then tracks the newest version the respective list provides)
  const VERSION_KEYS = ['minecraftVersion', 'neoformVersion', 'neoforgeVersion', 'forgeVersion', 'fabricApiVersion', 'fabricLoaderVersion', 'modMenuVersion',
    'gradleVersion', 'multiloaderPluginVersion', 'moddevVersion', 'loomVersion', 'forgeGradleVersion', 'modPublishPluginVersion', 'foojayVersion'];
  // javaVersion has no control of its own: it always follows Mojang's manifest, so it stays out
  // of the link as well (it is derived from the Minecraft version anyway)
  const AUTO_KEYS = ['modId', 'basePackage', 'classPrefix', 'rootProjectName', 'issuesUrl', 'javaVersion', ...VERSION_KEYS];
  const HASH_EXCLUDE = new Set(['icon', 'banner']);
  const MC_DEPENDENT = ['neoformVersion', 'neoforgeVersion', 'forgeVersion', 'fabricApiVersion', 'modMenuVersion'];
  // form field -> catalog list for the build tooling dropdowns
  const TOOL_LIST_LIMIT = 10; // build tooling dropdowns show the newest N versions
  const API_LIST_LIMIT = 15;  // loader / API dropdowns show the newest N versions
  const TOOL_FIELDS = { gradleVersion: 'gradle', multiloaderPluginVersion: 'multiloaderPlugin', moddevVersion: 'moddev', loomVersion: 'loom', forgeGradleVersion: 'forgeGradle', modPublishPluginVersion: 'modPublishPlugin', foojayVersion: 'foojay' };
  const CUSTOM = '__custom__';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  let state = null;
  const auto = Object.fromEntries(AUTO_KEYS.map((k) => [k, true]));
  let files = [];          // generated output of the current config, handed to the download
  let objectUrls = {};

  // version catalog state
  let catalog = null;
  let catalogOrigin = 'none';
  let catalogLoading = true;
  let includeSnapshots = false;
  const customMode = new Set();   // version fields currently in "Custom…" text mode
  const knownJava = {};           // minecraft id -> required Java major
  const modMenuCache = {};        // minecraft id -> [{ version, type }]

  // ---------------------------------------------------------------------------
  // template selection
  // ---------------------------------------------------------------------------
  /**
   * Which template serves this Minecraft version: exact match first, then ever shorter
   * version prefixes, finally the default branch. 26.1.2 falls back to 26.1, and a
   * snapshot such as 26.3-rc-1 is reduced to 26.3 before the search.
   */
  function resolveEntry(mc) {
    const parts = String(mc || '').split('-')[0].split('.').filter(Boolean);
    for (let n = parts.length; n >= 1; n--) {
      const hit = MANIFEST.entries[parts.slice(0, n).join('.')];
      if (hit) return hit;
    }
    return MANIFEST.entries.default;
  }

  const loadingSnapshots = new Map();
  function loadSnapshot(key) {
    if (window.TEMPLATE_SNAPSHOTS[key]) return Promise.resolve();
    if (loadingSnapshots.has(key)) return loadingSnapshots.get(key);
    const p = new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = `js/templates/${key}.js`;
      el.onload = resolve;
      el.onerror = () => reject(new Error(`could not load the template snapshot "${key}"`));
      document.head.appendChild(el);
    }).finally(() => loadingSnapshots.delete(key));
    loadingSnapshots.set(key, p);
    return p;
  }

  function useEntry(next) {
    const td = window.TEMPLATE_SNAPSHOTS[next.snapshot];
    const nextDefaults = ModGen.uiDefaults(td);
    if (state) {
      // fields the user never touched follow the new template
      for (const k of Object.keys(nextDefaults)) {
        if (k === 'loaders' || HASH_EXCLUDE.has(k)) continue;
        if (state[k] === defaults[k]) state[k] = nextDefaults[k];
      }
    }
    entry = next;
    TD = td;
    defaults = nextDefaults;
    if (state) renderSnapshotInfo();
  }

  /** Make sure the template matching `mc` is loaded; re-renders once a fetched one arrives. */
  function ensureTemplate(mc) {
    const next = resolveEntry(mc);
    if (next === entry) return;
    if (window.TEMPLATE_SNAPSHOTS[next.snapshot]) { useEntry(next); return; }
    loadSnapshot(next.snapshot)
      .then(() => { if (resolveEntry(state.minecraftVersion) === next) { useEntry(next); update({ immediate: true }); } })
      .catch((e) => { console.error(e); toast('Could not load the template for Minecraft ' + mc + '.'); });
  }

  // ---------------------------------------------------------------------------
  // state helpers
  // ---------------------------------------------------------------------------
  function getKey(key) {
    return key.startsWith('loaders.') ? state.loaders[key.slice(8)] : state[key];
  }
  function setKey(key, value) {
    if (key.startsWith('loaders.')) state.loaders[key.slice(8)] = value;
    else state[key] = value;
  }

  function applyAuto() {
    if (auto.modId) state.modId = ModGen.suggestModId(state.modName);
    if (auto.basePackage) state.basePackage = ModGen.suggestPackage(state.group, state.modId);
    if (auto.classPrefix) state.classPrefix = ModGen.suggestClassPrefix(state.modName, state.modId);
    if (auto.rootProjectName) state.rootProjectName = ModGen.suggestRootProjectName(state.modName, state.modId);
    if (auto.issuesUrl) state.issuesUrl = ModGen.suggestIssuesUrl(state.sourcesUrl);
    if (catalog && !catalogLoading) {
      const releases = catalog.minecraftVersions({ snapshots: false });
      if (auto.minecraftVersion && releases[0]) state.minecraftVersion = releases[0].id;
      const mc = state.minecraftVersion;
      const m = catalog.forMinecraft(mc);
      if (auto.neoformVersion) state.neoformVersion = m.neoform[0] || '';
      if (auto.neoforgeVersion) state.neoforgeVersion = m.neoforge[0] || '';
      if (auto.forgeVersion) state.forgeVersion = m.forge[0] || '';
      if (auto.fabricApiVersion) state.fabricApiVersion = m.fabricApi[0] || '';
      if (auto.fabricLoaderVersion) state.fabricLoaderVersion = catalog.latestFabricLoader() || state.fabricLoaderVersion;
      if (auto.modMenuVersion && modMenuCache[mc]) state.modMenuVersion = (modMenuCache[mc][0] || {}).version || '';
      const tools = catalog.tools();
      for (const [field, list] of Object.entries(TOOL_FIELDS)) {
        if (auto[field] && tools[list] && tools[list][0]) state[field] = tools[list][0];
      }
    }
    if (knownJava[state.minecraftVersion]) state.javaVersion = knownJava[state.minecraftVersion];
  }

  /**
   * Which loaders have builds for a Minecraft version. Returns null when this cannot be known
   * (catalog not loaded, or a hand-typed version the manifest does not list) - then nothing is restricted.
   */
  function loaderSupport(mc) {
    if (!catalog || catalogLoading || !catalog.hasMinecraft(mc)) return null;
    const m = catalog.forMinecraft(mc);
    return { fabric: m.fabricApi.length > 0, forge: m.forge.length > 0, neoforge: m.neoforge.length > 0, neoform: m.neoform.length > 0 };
  }

  /** state holds what the user wants; the effective config drops loaders the chosen Minecraft version cannot use. */
  function currentConfig() {
    const cfg = ModGen.normalizeConfig(state, defaults);
    // Mod Menu rides along with Fabric whenever a build exists for this Minecraft version
    cfg.modMenu = cfg.loaders.fabric && !!cfg.modMenuVersion;
    const sup = loaderSupport(cfg.minecraftVersion);
    if (sup) {
      for (const l of ['fabric', 'forge', 'neoforge']) if (!sup[l]) cfg.loaders[l] = false;
      if (!sup.neoforge) cfg.datagen = false; // the datagen module runs on NeoForge
    }
    return cfg;
  }

  // ---------------------------------------------------------------------------
  // URL hash <-> config (binary assets are never stored)
  // ---------------------------------------------------------------------------
  function encodeHash() {
    const diff = {};
    for (const k of Object.keys(defaults)) {
      if (HASH_EXCLUDE.has(k)) continue;
      if (AUTO_KEYS.includes(k) && auto[k]) continue; // recomputed from its sources on load
      if (k === 'loaders') {
        const ld = {};
        for (const l of Object.keys(defaults.loaders)) if (state.loaders[l] !== defaults.loaders[l]) ld[l] = state.loaders[l];
        if (Object.keys(ld).length) diff.loaders = ld;
      } else if (state[k] !== defaults[k]) {
        diff[k] = state[k];
      }
    }
    const json = JSON.stringify(diff);
    if (json === '{}') return '';
    return 'c=' + btoa(unescape(encodeURIComponent(json))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function decodeHash() {
    const m = location.hash.match(/[#&]c=([A-Za-z0-9_-]+)/);
    if (!m) return null;
    try {
      const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(decodeURIComponent(escape(atob(b64))));
    } catch (e) {
      console.warn('ignoring invalid config in URL', e);
      return null;
    }
  }

  function loadFromHash() {
    const diff = decodeHash();
    if (!diff) return;
    delete diff._manual;
    state = ModGen.normalizeConfig(diff, defaults);
    state.icon = null; state.banner = null;
    for (const k of AUTO_KEYS) auto[k] = !(k in diff); // a derived field in the link means the user overrode it
  }

  let hashTimer = null;
  function scheduleHashUpdate() {
    clearTimeout(hashTimer);
    hashTimer = setTimeout(() => {
      const h = encodeHash();
      const url = location.pathname + location.search + (h ? '#' + h : '');
      history.replaceState(null, '', url);
    }, 400);
  }

  // ---------------------------------------------------------------------------
  // version catalog
  // ---------------------------------------------------------------------------
  let catalogRefreshing = false;
  async function loadCatalog(force) {
    if (!catalog && window.VERSION_DATA) {
      // bundled lists are available synchronously; the live refresh replaces them when it arrives
      catalog = new VersionCatalog.Catalog(VersionCatalog.normalizeData(window.VERSION_DATA, 'bundled'));
      catalogOrigin = 'bundled';
      catalogLoading = false;
      Object.assign(knownJava, catalog.data.javaByMinecraft);
      Object.assign(modMenuCache, catalog.data.modMenu);
      update({ immediate: true });
    }
    catalogRefreshing = true;
    renderVersionsStatus();
    try {
      const r = await VersionCatalog.load({ force });
      catalog = r.catalog;
      catalogOrigin = r.origin;
      Object.assign(knownJava, catalog.data.javaByMinecraft);
      Object.assign(modMenuCache, catalog.data.modMenu);
      if (catalog.isSnapshot(state.minecraftVersion)) { includeSnapshots = true; $('#opt-snapshots').checked = true; }
    } catch (e) {
      console.error('version catalog failed', e);
      catalog = new VersionCatalog.Catalog(null);
      catalogOrigin = 'none';
    }
    catalogLoading = false;
    catalogRefreshing = false;
    renderVersionsStatus();
    ensureJava(state.minecraftVersion);
    ensureModMenu(state.minecraftVersion);
    update({ immediate: true });
  }

  async function ensureJava(mc) {
    if (!catalog || !mc || knownJava[mc]) return;
    try {
      const j = await catalog.javaFor(mc);
      if (j) { knownJava[mc] = j; update(); }
    } catch (e) { console.warn('java lookup failed for', mc, e); }
  }

  async function ensureModMenu(mc) {
    if (!catalog || !mc || modMenuCache[mc]) return;
    try {
      const list = await catalog.modMenuFor(mc);
      modMenuCache[mc] = list;
      if (state.minecraftVersion === mc && !state.modMenuVersion && list[0]) state.modMenuVersion = list[0].version;
      update();
    } catch (e) {
      console.warn('mod menu lookup failed for', mc, e);
      modMenuCache[mc] = [];
      update();
    }
  }

  /** Called when the Minecraft version changes: every dependent field follows the newest build for it again. */
  function applyMinecraftDefaults(mc) {
    for (const k of MC_DEPENDENT) { auto[k] = true; customMode.delete(k); }
    // clear first, so a version belonging to the previous Minecraft release is never carried over
    state.modMenuVersion = ((modMenuCache[mc] || [])[0] || {}).version || '';
    ensureJava(mc);
    ensureModMenu(mc);
  }

  /** Newest `limit` entries of `full`, plus the currently selected value if it is further down the list. */
  function capped(full, key, limit, id = (v) => v) {
    const current = String(state[key] || '');
    const list = full.slice(0, limit);
    if (current && !list.some((v) => id(v) === current)) {
      const cur = full.find((v) => id(v) === current);
      if (cur) list.push(cur);
    }
    return list;
  }

  function versionOptions(key, mapped, tools) {
    const mc = state.minecraftVersion;
    const plain = (list) => list.map((v) => ({ value: v, label: v }));
    if (key in TOOL_FIELDS) return plain(capped((tools && tools[TOOL_FIELDS[key]]) || [], key, TOOL_LIST_LIMIT));
    switch (key) {
      case 'minecraftVersion':
        // no type suffix: every non-release id already says what it is (-snapshot-N, -pre-N, -rc-N)
        return catalog.minecraftVersions({ snapshots: includeSnapshots }).map((v) => ({ value: v.id, label: v.id }));
      case 'neoformVersion': return plain(capped(mapped.neoform, key, API_LIST_LIMIT));
      case 'neoforgeVersion': return plain(capped(mapped.neoforge, key, API_LIST_LIMIT));
      case 'forgeVersion': return plain(capped(mapped.forge, key, API_LIST_LIMIT));
      case 'fabricApiVersion': return plain(capped(mapped.fabricApi, key, API_LIST_LIMIT));
      case 'fabricLoaderVersion':
        // Fabric only flags the current recommended loader as stable
        return capped(mapped.fabricLoader, key, API_LIST_LIMIT, (v) => v.version)
          .map((v) => ({ value: v.version, label: v.stable ? `${v.version} (stable)` : v.version }));
      case 'modMenuVersion':
        return capped(modMenuCache[mc] || [], key, API_LIST_LIMIT, (v) => v.version)
          .map((v) => ({ value: v.version, label: v.type === 'release' ? v.version : `${v.version} (${v.type})` }));
      default: return [];
    }
  }

  function renderVersionSelects() {
    const active = document.activeElement;
    const mapped = catalog ? catalog.forMinecraft(state.minecraftVersion) : null;
    const tools = catalog ? catalog.tools() : null;
    for (const sel of $$('select[data-versions]')) {
      const key = sel.dataset.key;
      const value = String(getKey(key) == null ? '' : getKey(key));
      const input = sel.closest('.select-custom') ? sel.closest('.select-custom').querySelector(`[data-custom-for="${key}"]`) : null;
      const customAllowed = !!input;
      let options = catalog && !catalogLoading ? versionOptions(key, mapped, tools) : (value ? [{ value, label: value }] : []);
      const inList = options.some((o) => String(o.value) === value);
      const custom = customAllowed && !catalogLoading && (customMode.has(key) || !inList);

      if (sel !== active) {
        const desired = options.map((o) => [String(o.value), o.label]);
        if (customAllowed && !catalogLoading) desired.push([CUSTOM, 'Custom…']);
        if (!customAllowed && !inList && value) desired.push([value, value]);
        setOptions(sel, desired);
        const want = custom ? CUSTOM : value;
        if (sel.value !== want) sel.value = want;
        const hide = customAllowed && options.length === 0 && !catalogLoading;
        if (sel.hidden !== hide) sel.hidden = hide;
      }
      if (input) {
        input.hidden = !custom;
        if (input !== active) input.value = value;
      }
      const note = sel.closest('.field') && sel.closest('.field').querySelector(`[data-versions-note="${key}"]`);
      if (note) {
        const none = catalog && !catalogLoading && options.length === 0;
        note.hidden = !none;
        note.textContent = none
          ? (key in TOOL_FIELDS
            ? `No ${VERSION_LABELS[key] || key} versions could be loaded. Enter one manually.`
            : `No ${VERSION_LABELS[key] || key} build is listed for Minecraft ${state.minecraftVersion}. Enter one manually or pick another Minecraft version.`)
          : '';
      }
    }
  }
  const VERSION_LABELS = { neoformVersion: 'NeoForm', neoforgeVersion: 'NeoForge', forgeVersion: 'Forge', fabricApiVersion: 'Fabric API', fabricLoaderVersion: 'Fabric Loader', modMenuVersion: 'Mod Menu',
    gradleVersion: 'Gradle', multiloaderPluginVersion: 'Multiloader plugin', moddevVersion: 'ModDevGradle', loomVersion: 'Fabric Loom', forgeGradleVersion: 'ForgeGradle', modPublishPluginVersion: 'mod-publish-plugin', foojayVersion: 'Foojay resolver' };

  /** Replace a select's options only if they differ - rebuilding on every update reflows the page and can close open popups. */
  function setOptions(sel, desired) {
    const current = sel.options;
    if (current.length === desired.length && desired.every((d, i) => current[i].value === d[0] && current[i].text === d[1])) return;
    sel.innerHTML = '';
    for (const [v, l] of desired) sel.appendChild(new Option(l, v));
  }

  function renderVersionsStatus() {
    const el = $('#versions-status');
    const txt = $('#versions-status-text');
    if (catalogLoading || catalogRefreshing) { el.className = 'versions-status loading'; txt.textContent = 'Loading version lists…'; return; }
    const when = catalog && catalog.fetchedAt ? new Date(catalog.fetchedAt) : null;
    const fmtTime = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const degraded = Object.entries(catalog.sources)
      .filter(([, s]) => s.origin !== 'live' && s.origin !== 'cache' && !s.skipped)
      .map(([k, s]) => `${VersionCatalog.SOURCES[k].label} ${s.origin === 'bundled' ? '(bundled list)' : '(unavailable)'}`);
    let cls = 'versions-status', msg;
    if (catalogOrigin === 'live') { cls += ' live'; msg = `Version lists fetched at ${fmtTime(when)}`; }
    else if (catalogOrigin === 'cache') { cls += ' live'; msg = `Version lists from ${fmtTime(when)} (cached for an hour)`; }
    else if (catalogOrigin === 'bundled') { msg = `Could not reach the version servers; using the bundled lists from ${when ? when.toLocaleDateString() : 'the last build'}`; }
    else { cls += ' error'; msg = 'Version lists unavailable. Enter versions manually.'; }
    if (degraded.length && (catalogOrigin === 'live' || catalogOrigin === 'cache')) msg += ` · ${degraded.join(', ')}`;
    el.className = cls;
    txt.textContent = msg;
  }

  // ---------------------------------------------------------------------------
  // rendering: form
  // ---------------------------------------------------------------------------
  let effective = null; // effective config of the current render pass (see currentConfig)
  function getEffective(key) {
    if (!effective) return getKey(key);
    return key.startsWith('loaders.') ? effective.loaders[key.slice(8)] : effective[key];
  }

  function evalShowIf(expr) {
    if (expr.includes('&')) return expr.split('&').every((k) => !!getEffective(k.trim()));
    return expr.split('|').some((k) => !!getEffective(k.trim()));
  }

  function renderForm(errors, cfg) {
    const active = document.activeElement;
    effective = cfg;
    const sup = loaderSupport(cfg.minecraftVersion);
    renderVersionSelects();
    for (const el of $$('[data-key]')) {
      const key = el.dataset.key;
      const value = getKey(key);
      if (el.type === 'checkbox') {
        const loader = key.startsWith('loaders.') ? key.slice(8) : null;
        const blocked = !!sup && ((loader && !sup[loader]) || (key === 'datagen' && !sup.neoforge));
        el.checked = blocked ? false : !!value;
        el.disabled = blocked;
        const box = el.closest('.toggle, .loader-chip');
        if (box) {
          box.classList.toggle('disabled', blocked);
          box.classList.toggle('unsupported', blocked);
          box.title = blocked ? `Not available for Minecraft ${cfg.minecraftVersion}` : '';
        }
      }
      else if (el.dataset.versions === undefined && el !== active) el.value = value == null ? '' : String(value);
      const field = el.closest('.field');
      if (field) field.classList.toggle('invalid', errors.some((e) => e.field === key));
    }
    for (const el of $$('[data-unsupported-note]')) {
      const key = el.dataset.unsupportedNote;
      const blocked = !!sup && (key === 'datagen' ? !sup.neoforge : !sup[key]);
      el.hidden = !blocked;
      el.textContent = blocked ? (key === 'datagen' ? `Needs a NeoForge build for Minecraft ${cfg.minecraftVersion}.` : `no build for ${cfg.minecraftVersion}`) : '';
    }
    for (const el of $$('[data-error-for]')) {
      const errs = errors.filter((e) => e.field === el.dataset.errorFor);
      el.textContent = errs.map((e) => e.message).join(' ');
    }
    for (const el of $$('[data-show-if]')) el.hidden = !evalShowIf(el.dataset.showIf);
    for (const el of $$('[data-auto-label]')) el.textContent = auto[el.dataset.autoLabel] ? (el.dataset.autoWord || 'auto') : 'custom';
    for (const el of $$('[data-reset-auto]')) el.hidden = auto[el.dataset.resetAuto];
    for (const el of $$('[data-chip]')) el.classList.toggle('on', !!cfg.loaders[el.dataset.chip]);
    for (const el of $$('[data-version-of]')) {
      const chip = el.closest('[data-chip]');
      const blocked = chip && sup && !sup[chip.dataset.chip];
      el.hidden = !!blocked;
      el.textContent = blocked ? '' : (state[el.dataset.versionOf] || '');
    }
    for (const el of $$('[data-asset-name]')) el.textContent = `${state.modId || 'mod'}${el.dataset.assetName === 'banner' ? '_banner' : ''}.png`;
  }

  function renderValidation(errors) {
    const btn = $('#btn-download');
    btn.classList.toggle('invalid', errors.length > 0);
    btn.disabled = errors.length > 0;
    btn.textContent = errors.length ? `${errors.length} issue${errors.length > 1 ? 's' : ''} to fix` : '⬇ Download ZIP';
    btn.title = errors.map((e) => e.message).join('\n');
  }


  // ---------------------------------------------------------------------------
  // light / dark mode
  // ---------------------------------------------------------------------------
  const THEME_KEY = 'modgen.theme';

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    const btn = $('#btn-theme');
    if (btn) btn.title = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
  }

  function bindTheme() {
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
    $('#btn-theme').addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* private mode */ }
    });
    // follow the system as long as the user has not chosen a mode here
    const media = matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', (e) => {
      let stored = null;
      try { stored = localStorage.getItem(THEME_KEY); } catch (err) {}
      if (!stored) applyTheme(e.matches ? 'dark' : 'light');
    });
  }

  // ---------------------------------------------------------------------------
  // misc rendering helpers
  // ---------------------------------------------------------------------------
  function objectUrl(key, bytes, type) {
    if (objectUrls[key]) URL.revokeObjectURL(objectUrls[key]);
    objectUrls[key] = URL.createObjectURL(new Blob([bytes], { type }));
    return objectUrls[key];
  }

  // ---------------------------------------------------------------------------
  // main update cycle
  // ---------------------------------------------------------------------------
  let generateTimer = null;
  let lastErrors = [];

  function update({ immediate = false } = {}) {
    applyAuto();
    ensureTemplate(state.minecraftVersion);
    const cfg = currentConfig();
    lastErrors = ModGen.validate(cfg);
    renderForm(lastErrors, cfg);
    renderValidation(lastErrors);
    scheduleHashUpdate();

    clearTimeout(generateTimer);
    const run = () => {
      try {
        files = lastErrors.length ? [] : ModGen.generate(TD, cfg);
      } catch (e) {
        console.error(e);
        files = [];
        renderValidation([{ field: '', message: 'Generation failed: ' + e.message }]);
      }
    };
    if (immediate) run(); else generateTimer = setTimeout(run, 120);
  }

  // ---------------------------------------------------------------------------
  // events
  // ---------------------------------------------------------------------------
  function bindForm() {
    for (const el of $$('[data-key]')) {
      const key = el.dataset.key;
      if (el.dataset.versions !== undefined) {
        el.addEventListener('blur', () => renderVersionSelects());
        el.addEventListener('change', () => {
          if (el.value === CUSTOM) {
            customMode.add(key);
            update({ immediate: true });
            const input = el.closest('.select-custom') && el.closest('.select-custom').querySelector(`[data-custom-for="${key}"]`);
            if (input) { input.focus(); input.select(); }
            return;
          }
          customMode.delete(key);
          setKey(key, el.value);
          if (AUTO_KEYS.includes(key)) auto[key] = false;
          if (key === 'minecraftVersion') applyMinecraftDefaults(el.value);
          update();
        });
        continue;
      }
      const handler = () => {
        let value = el.type === 'checkbox' ? el.checked : el.value;
        if (el.tagName === 'TEXTAREA' && /[\r\n]/.test(value)) { value = value.replace(/\s*[\r\n]+\s*/g, ' '); el.value = value; }
        setKey(key, value);
        if (AUTO_KEYS.includes(key)) auto[key] = value === '';
        update();
      };
      el.addEventListener('input', handler);
      el.addEventListener('change', handler);
    }
    for (const input of $$('[data-custom-for]')) {
      const key = input.dataset.customFor;
      input.addEventListener('input', () => { customMode.add(key); auto[key] = false; setKey(key, input.value.trim()); update(); });
      if (key === 'minecraftVersion') input.addEventListener('change', () => { applyMinecraftDefaults(input.value.trim()); update(); });
    }
    $('#opt-snapshots').addEventListener('change', (e) => { includeSnapshots = e.target.checked; update({ immediate: true }); });
    $('#btn-refresh-versions').addEventListener('click', () => loadCatalog(true));

    for (const btn of $$('[data-reset-auto]')) {
      btn.addEventListener('click', () => { auto[btn.dataset.resetAuto] = true; update(); });
    }
    for (const input of $$('[data-asset]')) {
      input.addEventListener('change', async () => {
        const kind = input.dataset.asset;
        const file = input.files && input.files[0];
        if (!file) return;
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (!(bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)) {
          toast('Please choose a PNG file.');
          input.value = '';
          return;
        }
        state[kind] = bytes;
        showAsset(kind, file.name, bytes);
        update({ immediate: true });
      });
    }
    for (const btn of $$('[data-asset-remove]')) {
      btn.addEventListener('click', () => {
        const kind = btn.dataset.assetRemove;
        state[kind] = null;
        $(`[data-asset="${kind}"]`).value = '';
        showAsset(kind, null, null);
        update({ immediate: true });
      });
    }

    bindTheme();
    $('#btn-download').addEventListener('click', download);
    $('#btn-share').addEventListener('click', async () => {
      const h = encodeHash();
      const url = location.href.split('#')[0] + (h ? '#' + h : '');
      try {
        await navigator.clipboard.writeText(url);
        toast('Link copied to clipboard.');
      } catch (e) {
        window.prompt('Copy this link:', url);
      }
    });
    $('#btn-reset').addEventListener('click', () => {
      state = Object.assign({}, defaults, { loaders: Object.assign({}, defaults.loaders) });
      for (const k of AUTO_KEYS) auto[k] = true;
      customMode.clear();
      for (const kind of ['icon', 'banner']) { $(`[data-asset="${kind}"]`).value = ''; showAsset(kind, null, null); }
      history.replaceState(null, '', location.pathname + location.search);
      update({ immediate: true });
      toast('Reset to defaults.');
    });
  }

  function showAsset(kind, name, bytes) {
    const img = $(`[data-asset-preview="${kind}"]`);
    const meta = $(`[data-asset-meta="${kind}"]`);
    const remove = $(`[data-asset-remove="${kind}"]`);
    if (!bytes) {
      img.hidden = true; img.removeAttribute('src');
      meta.textContent = kind === 'icon' ? 'No file. Square PNG, e.g. 128×128.' : 'No file. Wide PNG for Forge/NeoForge mod lists.';
      remove.hidden = true;
      return;
    }
    img.hidden = false;
    img.src = objectUrl('asset:' + kind, bytes, 'image/png');
    img.onload = () => { meta.textContent = `${name} · ${img.naturalWidth}×${img.naturalHeight} · ${formatSize(bytes.length)}`; };
    meta.textContent = `${name} · ${formatSize(bytes.length)}`;
    remove.hidden = false;
  }

  async function download() {
    const cfg = currentConfig();
    if (ModGen.validate(cfg).length) return;
    const btn = $('#btn-download');
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = 'Packing…';
    try {
      const out = ModGen.generate(TD, cfg);
      const blob = await ModGen.buildZip(out);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${cfg.rootProjectName}.zip`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
      toast(`Downloaded ${a.download} (${formatSize(blob.size)}).`);
    } catch (e) {
      console.error(e);
      toast('Failed to build the ZIP: ' + e.message);
    } finally {
      btn.textContent = label;
      btn.disabled = false;
    }
  }

  // ---------------------------------------------------------------------------
  // misc
  // ---------------------------------------------------------------------------
  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  function formatSize(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
    return `${(n / 1024 / 1024).toFixed(2)} MiB`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function populateLicenses() {
    const sel = $('#f-modLicense');
    for (const l of ModGen.LICENSES) {
      const o = document.createElement('option');
      o.value = l.id;
      o.textContent = l.label;
      sel.appendChild(o);
    }
  }

  function renderSnapshotInfo() {
    const src = (MANIFEST.source || '').replace(/\.git$/, '');
    const short = (entry.commit || '').slice(0, 7);
    const date = entry.commitDate ? new Date(entry.commitDate).toLocaleDateString() : '';
    const branch = escapeHtml(entry.branch);
    $('#snapshot-info').innerHTML = `Template: branch <a href="${escapeHtml(src)}/tree/${branch}" target="_blank" rel="noopener"><code>${branch}</code></a>`
      + ` for Minecraft ${escapeHtml(entry.minecraftVersion)}, snapshot <a href="${escapeHtml(src)}/tree/${escapeHtml(entry.commit || '')}" target="_blank" rel="noopener"><code>${escapeHtml(short)}</code></a>`
      + `${date ? ' from ' + escapeHtml(date) : ''}.`;
    if (src) $('#link-template').href = src;
  }

  /** The Minecraft version the page starts on: from the shared link, else the newest bundled release. */
  function startupMinecraftVersion() {
    const diff = decodeHash();
    if (diff && diff.minecraftVersion) return diff.minecraftVersion;
    try {
      const bundled = new VersionCatalog.Catalog(VersionCatalog.normalizeData(window.VERSION_DATA, 'bundled'));
      const newest = bundled.minecraftVersions({ snapshots: false })[0];
      if (newest) return newest.id;
    } catch (e) { /* fall through to the default branch */ }
    return null;
  }

  async function init() {
    populateLicenses();
    const first = resolveEntry(startupMinecraftVersion());
    try {
      await loadSnapshot(first.snapshot);
    } catch (e) {
      console.error(e);
      document.body.insertAdjacentHTML('afterbegin',
        '<div class="validation">The template could not be loaded. Please reload the page.</div>');
      return;
    }
    useEntry(first);
    state = Object.assign({}, defaults, { loaders: Object.assign({}, defaults.loaders) });
    loadFromHash();
    renderSnapshotInfo();
    bindForm();
    update({ immediate: true });
    loadCatalog(false);
    window.addEventListener('hashchange', () => { loadFromHash(); customMode.clear(); update({ immediate: true }); });
  }

  // read-only hook for tests/ui-driver.html
  window.ModGenApp = { getFiles: () => files, getConfig: () => currentConfig(), getErrors: () => lastErrors, getTemplate: () => entry };

  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', init) : init();
})();
