/* app.js - UI glue for index.html. Generation logic lives in generator.js, version lists in versions.js. */
(function () {
  'use strict';

  const TD = window.TEMPLATE_DATA;
  const defaults = ModGen.uiDefaults(TD);
  const templateDefaults = ModGen.templateDefaults(TD);
  const AUTO_KEYS = ['modId', 'basePackage', 'classPrefix', 'rootProjectName', 'issuesUrl', 'javaVersion'];
  const HASH_EXCLUDE = new Set(['icon', 'banner']);
  const MC_DEPENDENT = ['neoformVersion', 'neoforgeVersion', 'forgeVersion', 'fabricApiVersion', 'modMenuVersion'];
  // form field -> catalog list for the build tooling dropdowns
  const TOOL_LIST_LIMIT = 10; // build tooling dropdowns show the newest N versions
  const TOOL_FIELDS = { gradleVersion: 'gradle', multiloaderPluginVersion: 'multiloaderPlugin', moddevVersion: 'moddev', loomVersion: 'loom', forgeGradleVersion: 'forgeGradle', modPublishPluginVersion: 'modPublishPlugin', foojayVersion: 'foojay' };
  const CUSTOM = '__custom__';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  let state = Object.assign({}, defaults, { loaders: Object.assign({}, defaults.loaders) });
  const auto = Object.fromEntries(AUTO_KEYS.map((k) => [k, true]));
  let files = [];          // generated output of the current config (for the summary and the download)
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
    if (auto.javaVersion && knownJava[state.minecraftVersion]) state.javaVersion = knownJava[state.minecraftVersion];
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
  async function loadCatalog(force) {
    catalogLoading = true;
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

  /** Called when the Minecraft version changes: pick the newest matching build for every dependent field. */
  function applyMinecraftDefaults(mc) {
    if (!catalog) return;
    const m = catalog.forMinecraft(mc);
    state.neoformVersion = m.neoform[0] || '';
    state.neoforgeVersion = m.neoforge[0] || '';
    state.forgeVersion = m.forge[0] || '';
    state.fabricApiVersion = m.fabricApi[0] || '';
    if (!state.fabricLoaderVersion) state.fabricLoaderVersion = catalog.latestFabricLoader();
    state.modMenuVersion = ((modMenuCache[mc] || [])[0] || {}).version || '';
    for (const k of MC_DEPENDENT) customMode.delete(k);
    ensureJava(mc);
    ensureModMenu(mc);
  }

  function versionOptions(key, mapped, tools) {
    const mc = state.minecraftVersion;
    const isTool = key in TOOL_FIELDS;
    const tpl = (v) => String(v) === String(templateDefaults[key]) && (isTool || mc === templateDefaults.minecraftVersion);
    const plain = (list) => list.map((v) => ({ value: v, label: v, tpl: tpl(v) }));
    if (isTool) {
      const full = (tools && tools[TOOL_FIELDS[key]]) || [];
      const current = String(state[key] || '');
      const list = full.slice(0, TOOL_LIST_LIMIT);
      if (current && !list.includes(current) && full.includes(current)) list.push(current); // keep an older pick visible
      const options = plain(list);
      // the template may pin something that is not a plain list entry (e.g. the ForgeGradle range "[7.0.30, 8)")
      const t = templateDefaults[key];
      if (t && !options.some((o) => o.value === t)) options.unshift({ value: t, label: t, tpl: true });
      return options;
    }
    switch (key) {
      case 'minecraftVersion':
        return catalog.minecraftVersions({ snapshots: includeSnapshots }).map((v) => ({
          value: v.id, label: v.type === 'release' ? v.id : `${v.id} (${v.type})`, tpl: v.id === templateDefaults.minecraftVersion,
        }));
      case 'javaVersion': {
        const set = new Set([17, 21, 25, knownJava[mc], parseInt(state.javaVersion, 10)].filter((n) => n));
        return Array.from(set).sort((a, b) => a - b).map((n) => ({ value: n, label: n === knownJava[mc] ? `${n} (required by ${mc})` : String(n), tpl: false }));
      }
      case 'neoformVersion': return plain(mapped.neoform);
      case 'neoforgeVersion': return plain(mapped.neoforge);
      case 'forgeVersion': return plain(mapped.forge);
      case 'fabricApiVersion': return plain(mapped.fabricApi);
      case 'fabricLoaderVersion': {
        // Fabric only flags the current recommended loader as stable; show the newest 40 (plus the selected one)
        const list = mapped.fabricLoader.slice(0, 40);
        if (state.fabricLoaderVersion && !list.some((v) => v.version === state.fabricLoaderVersion)) {
          const cur = mapped.fabricLoader.find((v) => v.version === state.fabricLoaderVersion);
          if (cur) list.push(cur);
        }
        return list.map((v) => ({ value: v.version, label: v.stable ? `${v.version} (stable)` : v.version, tpl: tpl(v.version) }));
      }
      case 'modMenuVersion':
        return (modMenuCache[mc] || []).map((v) => ({ value: v.version, label: v.type === 'release' ? v.version : `${v.version} (${v.type})`, tpl: tpl(v.version) }));
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
      const input = sel.parentElement.querySelector(`[data-custom-for="${key}"]`);
      const customAllowed = !!input;
      let options = catalog && !catalogLoading ? versionOptions(key, mapped, tools) : (value ? [{ value, label: value, tpl: false }] : []);
      const inList = options.some((o) => String(o.value) === value);
      const custom = customAllowed && !catalogLoading && (customMode.has(key) || !inList);

      if (sel !== active) {
        sel.innerHTML = '';
        for (const o of options) {
          const opt = new Option(o.label + (o.tpl ? ' · template' : ''), o.value);
          if (o.tpl) opt.className = 'tpl';
          sel.appendChild(opt);
        }
        if (customAllowed && !catalogLoading) sel.appendChild(new Option('Custom…', CUSTOM));
        if (!customAllowed && !inList && value) sel.appendChild(new Option(value, value));
        sel.value = custom ? CUSTOM : value;
        sel.hidden = customAllowed && options.length === 0 && !catalogLoading;
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

  function renderVersionsStatus() {
    const el = $('#versions-status');
    const txt = $('#versions-status-text');
    if (catalogLoading) { el.className = 'versions-status loading'; txt.textContent = 'Loading version lists…'; return; }
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
    for (const el of $$('[data-auto-label]')) el.textContent = auto[el.dataset.autoLabel] ? 'auto' : 'custom';
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

  function renderSummary(cfg) {
    const loaders = ['fabric', 'forge', 'neoforge'].filter((l) => cfg.loaders[l]).map((l) => ({ fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge' }[l]));
    const feats = [];
    if (cfg.datagen) feats.push('datagen');
    if (cfg.gametest) feats.push('gametests');
    if (cfg.testmod) feats.push('testmod');
    if (cfg.mixins) feats.push('mixins');
    if (cfg.modPublish) feats.push('publishing');
    $('#summary').textContent = `${cfg.rootProjectName}.zip · ${files.length} files · MC ${cfg.minecraftVersion} · ${loaders.join(', ') || 'no loader'}${feats.length ? ' · ' + feats.join(', ') : ''}`;
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
      renderSummary(cfg);
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
        el.addEventListener('change', () => {
          if (el.value === CUSTOM) {
            customMode.add(key);
            update({ immediate: true });
            const input = el.parentElement.querySelector(`[data-custom-for="${key}"]`);
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
      input.addEventListener('input', () => { customMode.add(key); setKey(key, input.value.trim()); update(); });
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
      const blob = await ModGen.buildZip(out, cfg);
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
    const src = (TD.source || '').replace(/\.git$/, '');
    const short = (TD.commit || '').slice(0, 7);
    const date = TD.commitDate ? new Date(TD.commitDate).toLocaleDateString() : '';
    $('#snapshot-info').innerHTML = `Template snapshot: <a href="${escapeHtml(src)}/tree/${escapeHtml(TD.commit || '')}" target="_blank" rel="noopener"><code>${escapeHtml(short)}</code></a>${date ? ' from ' + escapeHtml(date) : ''}.`;
    if (src) $('#link-template').href = src;
  }

  function init() {
    populateLicenses();
    renderSnapshotInfo();
    loadFromHash();
    bindForm();
    update({ immediate: true });
    loadCatalog(false);
    window.addEventListener('hashchange', () => { loadFromHash(); customMode.clear(); update({ immediate: true }); });
  }

  // read-only hook for tests/ui-driver.html
  window.ModGenApp = { getFiles: () => files, getConfig: () => currentConfig(), getErrors: () => lastErrors };

  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', init) : init();
})();
