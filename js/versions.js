/*
 * versions.js - live version catalog for the generator.
 *
 * Fetches the Minecraft version manifest plus the NeoForm / NeoForge / Forge / Fabric API /
 * Fabric Loader version lists (all endpoints allow browser requests), keeps only what the
 * multiloader plugin supports (Minecraft releases from 1.20.1 on; snapshots, pre-releases and
 * release candidates are rejected by the plugin), and maps loader versions to a Minecraft
 * version. Results are cached in localStorage for an hour; window.VERSION_DATA
 * (js/versions-data.js, produced by scripts/bake-versions.py) is the offline / fetch-failure fallback.
 *
 *   const { catalog, origin } = await VersionCatalog.load();
 *   catalog.minecraftVersions()          // [{ id, releaseTime }], newest first
 *   catalog.forMinecraft('1.21.1')       // { neoform, neoforge, forge, fabricApi, fabricLoader }
 *   await catalog.modMenuFor('1.21.1')   // [{ version, type }]
 */
(function (global) {
  'use strict';

  const MIN_MINECRAFT = '1.20.1';              // oldest version the multiloader plugin supports
  const MIN_PLUGIN = '0.2.0';                  // oldest plugin release with the DSL the generator writes
  const CACHE_KEY = 'modgen.versionCatalog.v3';
  const CACHE_TTL_MS = 60 * 60 * 1000;
  const MODRINTH_API = 'https://api.modrinth.com/v2';

  // group "minecraft": mapped per Minecraft version; group "tools": build tooling, independent of Minecraft.
  const SOURCES = {
    minecraft:    { group: 'minecraft', label: 'Minecraft',     url: 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json' },
    neoform:      { group: 'minecraft', label: 'NeoForm',       url: 'https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoform' },
    neoforge:     { group: 'minecraft', label: 'NeoForge',      url: 'https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge' },
    forge:        { group: 'minecraft', label: 'Forge',         url: 'https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml' },
    fabricApi:    { group: 'minecraft', label: 'Fabric API',    url: 'https://maven.fabricmc.net/net/fabricmc/fabric-api/fabric-api/maven-metadata.xml' },
    fabricLoader: { group: 'minecraft', label: 'Fabric Loader', url: 'https://meta.fabricmc.net/v2/versions/loader' },

    gradle:            { group: 'tools', label: 'Gradle',             url: 'https://services.gradle.org/versions/all' },
    multiloaderPlugin: { group: 'tools', label: 'Multiloader plugin', url: 'https://maven.morthen.net/api/maven/versions/releases/net/morthen/gradle/multiloader/net.morthen.gradle.multiloader.gradle.plugin' },
    moddev:            { group: 'tools', label: 'ModDevGradle',       url: 'https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/moddev-gradle' },
    loom:              { group: 'tools', label: 'Fabric Loom',        url: 'https://maven.fabricmc.net/net/fabricmc/fabric-loom/maven-metadata.xml' },
    forgeGradle:       { group: 'tools', label: 'ForgeGradle',        url: 'https://maven.minecraftforge.net/net/minecraftforge/gradle/net.minecraftforge.gradle.gradle.plugin/maven-metadata.xml' },
    foojay:            { group: 'tools', label: 'Foojay resolver',    url: 'https://api.github.com/repos/gradle/foojay-toolchains/tags?per_page=50' },
  };
  const LIST_KEYS = Object.keys(SOURCES);
  const TOOL_KEYS = LIST_KEYS.filter((k) => SOURCES[k].group === 'tools');

  // ---------------------------------------------------------------------------
  // version ordering
  // ---------------------------------------------------------------------------
  function segments(v) {
    return String(v).split(/[.+_-]/).filter((s) => s.length).map((s) => (/^\d+$/.test(s) ? Number(s) : s.toLowerCase()));
  }

  /** Numeric-aware compare; a trailing tag ("-beta") ranks below the untagged version. */
  function compareVersions(a, b) {
    const A = segments(a), B = segments(b);
    const n = Math.max(A.length, B.length);
    for (let i = 0; i < n; i++) {
      const x = A[i], y = B[i];
      if (x === undefined) return typeof y === 'string' ? 1 : -1;
      if (y === undefined) return typeof x === 'string' ? -1 : 1;
      if (typeof x === 'number' && typeof y === 'number') { if (x !== y) return x < y ? -1 : 1; continue; }
      if (typeof x === 'number') return 1;
      if (typeof y === 'number') return -1;
      if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  }

  /** Newest first, without duplicates (some Maven repositories list a version twice). */
  const newestFirst = (list, key) => {
    const seen = new Set();
    const unique = list.filter((v) => { const id = key ? v[key] : v; if (seen.has(id)) return false; seen.add(id); return true; });
    return unique.sort((a, b) => compareVersions(key ? b[key] : b, key ? a[key] : a));
  };

  /** Release ids only: "1.21.1", "26.1" (padded "26.1.0"). Returns null for snapshots and anything else. */
  function mcParts(id) {
    const m = String(id).match(/^(\d+)\.(\d+)(?:\.(\d+))?$/);
    if (!m) return null;
    const patch = m[3] ? +m[3] : 0;
    return { major: +m[1], minor: +m[2], patch, padded: `${m[1]}.${m[2]}.${patch}` };
  }
  const MIN_PARTS = mcParts(MIN_MINECRAFT);
  const atLeast = (p, min) => !!p && (p.major - min.major || p.minor - min.minor || p.patch - min.patch) >= 0;
  /** A Minecraft release the plugin supports. */
  const isSupported = (id) => atLeast(mcParts(id), MIN_PARTS);
  // NeoForge's own version: "20.4.237" for 1.20.4 (the "1." dropped) and "26.1.2.7" for 26.1.2
  const NEOFORGE_OLD_RE = /^(\d+)\.(\d+)\.\d+(-beta)?$/;
  const NEOFORGE_NEW_RE = /^(\d+)\.(\d+)\.(\d+)\.\d+(-beta)?$/;
  function neoforgeMinecraft(v) {
    let m = v.match(NEOFORGE_NEW_RE);
    if (m) return +m[1] >= 26 ? (m[3] === '0' ? `${m[1]}.${m[2]}` : `${m[1]}.${m[2]}.${m[3]}`) : null;
    m = v.match(NEOFORGE_OLD_RE);
    if (m && +m[1] >= 20 && +m[1] < 26) return m[2] === '0' ? `1.${m[1]}` : `1.${m[1]}.${m[2]}`;
    return null;
  }
  // NeoForm: "1.21.1-20240808.144430" up to 1.21.11, "26.1.2-1" from 26.1 on
  const NEOFORM_RE = /^(\d+\.\d+(?:\.\d+)?)-(\d{8}\.\d{6}|\d+)$/;

  // ---------------------------------------------------------------------------
  // parsers (one per source)
  // ---------------------------------------------------------------------------
  function parseMavenXml(text) {
    const out = [];
    const re = /<version>([^<]+)<\/version>/g;
    let m;
    while ((m = re.exec(text))) { const v = m[1].trim(); if (!out.includes(v)) out.push(v); }
    return out;
  }

  const PARSERS = {
    minecraft: (json) => (json.versions || []).filter((v) => v.type === 'release' && isSupported(v.id))
      .map((v) => ({ id: v.id, releaseTime: v.releaseTime })),
    neoform: (json) => (json.versions || []).filter((v) => { const m = v.match(NEOFORM_RE); return !!m && isSupported(m[1]); }),
    neoforge: (json) => (json.versions || []).filter((v) => isSupported(neoforgeMinecraft(v))),
    forge: (text) => parseMavenXml(text).filter((v) => { const i = v.indexOf('-'); return i > 0 && isSupported(v.slice(0, i)); }),
    fabricApi: (text) => parseMavenXml(text).filter((v) => { const i = v.indexOf('+'); return i > 0 && isSupported(v.slice(i + 1)); }),
    fabricLoader: (json) => newestFirst((json || []).map((v) => ({ version: v.version, stable: !!v.stable })), 'version'),

    // build tooling (already sorted newest first)
    gradle: (json) => newestFirst((json || [])
      .filter((v) => !v.snapshot && !v.nightly && !v.releaseNightly && !v.rcFor && !v.milestoneFor && !v.broken && parseInt(v.version, 10) >= 8)
      .map((v) => v.version)),
    // only releases that understand the build scripts the generator writes
    multiloaderPlugin: (json) => newestFirst((json.versions || []).filter((v) => /^\d+(\.\d+)+$/.test(v) && compareVersions(v, MIN_PLUGIN) >= 0)),
    moddev: (json) => newestFirst((json.versions || []).filter((v) => parseInt(v, 10) >= 2)).slice(0, 20),
    // Loom: final releases plus the rolling "<major>.<minor>-SNAPSHOT" lines the template uses
    loom: (text) => newestFirst(parseMavenXml(text).filter((v) => /-SNAPSHOT$/.test(v) || /^\d+\.\d+\.\d+$/.test(v))).slice(0, 20),
    forgeGradle: (text) => newestFirst(parseMavenXml(text)).slice(0, 20),
    foojay: (json) => newestFirst((json || []).map((t) => t.name || '')
      .filter((n) => n.startsWith('foojay-toolchains-plugin-'))
      .map((n) => n.slice('foojay-toolchains-plugin-'.length))),
  };
  const TEXT_SOURCES = new Set(['forge', 'fabricApi', 'loom', 'forgeGradle']);

  // ---------------------------------------------------------------------------
  // data container
  // ---------------------------------------------------------------------------
  function emptyData() {
    const d = { fetchedAt: null, sources: {}, modMenu: {} };
    for (const k of LIST_KEYS) d[k] = [];
    return d;
  }

  function normalizeData(raw, origin) {
    const d = emptyData();
    if (!raw || typeof raw !== 'object') return d;
    d.fetchedAt = raw.fetchedAt || null;
    for (const k of LIST_KEYS) {
      if (Array.isArray(raw[k]) && raw[k].length) { d[k] = raw[k]; d.sources[k] = { origin }; }
      else d.sources[k] = { origin: 'none' };
    }
    d.modMenu = Object.assign({}, raw.modMenu || {});
    return d;
  }

  /** `top` wins where it has data; gaps are filled from `base`. */
  function merge(base, top) {
    const d = emptyData();
    d.fetchedAt = top.fetchedAt || base.fetchedAt;
    for (const k of LIST_KEYS) {
      const t = top.sources[k] || { origin: 'none' };
      if (t.origin !== 'none' && t.origin !== 'failed' && top[k].length) { d[k] = top[k]; d.sources[k] = { origin: t.origin }; }
      else { d[k] = base[k]; d.sources[k] = { origin: (base.sources[k] || {}).origin || 'none', error: t.error }; }
    }
    d.modMenu = Object.assign({}, base.modMenu, top.modMenu);
    return d;
  }

  function readCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.fetchedAt) return null;
      return parsed;
    } catch (e) { return null; }
  }

  function saveCache(data) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch (e) { /* private mode, quota, ... */ }
  }

  function fetchWithTimeout(url, ms) {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), ms) : null;
    return fetch(url, { signal: ctrl ? ctrl.signal : undefined, cache: 'no-cache' }).finally(() => clearTimeout(timer));
  }

  async function fetchLive({ timeoutMs = 20000 } = {}) {
    const data = emptyData();
    data.fetchedAt = new Date().toISOString();
    await Promise.all(LIST_KEYS.map(async (key) => {
      try {
        const res = await fetchWithTimeout(SOURCES[key].url, timeoutMs);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const body = TEXT_SOURCES.has(key) ? await res.text() : await res.json();
        data[key] = PARSERS[key](body);
        data.sources[key] = { origin: 'live' };
      } catch (e) {
        data[key] = [];
        data.sources[key] = { origin: 'failed', error: String((e && e.message) || e) };
      }
    }));
    return data;
  }

  // ---------------------------------------------------------------------------
  // catalog
  // ---------------------------------------------------------------------------
  class Catalog {
    constructor(data) { this.data = data || emptyData(); }

    get fetchedAt() { return this.data.fetchedAt; }
    get sources() { return this.data.sources; }

    /** Supported Minecraft releases, newest first. */
    minecraftVersions() {
      return this.data.minecraft.filter((v) => isSupported(v.id));
    }

    hasMinecraft(id) { return this.data.minecraft.some((v) => v.id === id); }

    /** Loader versions that target one Minecraft version, newest first. */
    forMinecraft(id) {
      const d = this.data;
      const out = { neoform: [], neoforge: [], forge: [], fabricApi: [], fabricLoader: newestFirst(d.fabricLoader, 'version') };
      const p = mcParts(id);
      if (!p) return out;

      // NeoForm: "<mc>-<timestamp>" (1.21.1-20240808.144430) or "<mc>-<n>" (26.2-2)
      out.neoform = newestFirst(d.neoform.filter((v) => { const m = v.match(NEOFORM_RE); return !!m && m[1] === id; }));

      // NeoForge: "21.1.<build>" for 1.21.1, "21.0.<build>" for 1.21, "26.1.2.<build>" for 26.1.2 (each maybe "-beta").
      // 1.20.1 has none: its NeoForge was still published as net.neoforged:forge, which the plugin does not support.
      const target = p.major === 1 ? `1.${p.minor}${p.patch ? '.' + p.patch : ''}` : (p.patch ? `${p.major}.${p.minor}.${p.patch}` : `${p.major}.${p.minor}`);
      out.neoforge = newestFirst(d.neoforge.filter((v) => neoforgeMinecraft(v) === target));
      // once a release build exists for this Minecraft version, its beta builds are no longer offered
      if (out.neoforge.some((v) => !v.includes('-'))) out.neoforge = out.neoforge.filter((v) => !/-beta/i.test(v));

      // Forge: "<mc>-<forge version>"
      out.forge = newestFirst(d.forge.filter((v) => v.startsWith(id + '-')).map((v) => v.slice(id.length + 1)));

      // Fabric API: "<api>+<mc>"
      out.fabricApi = newestFirst(d.fabricApi.filter((v) => v.endsWith('+' + id)));
      return out;
    }

    /** Build-tool version lists (newest first), independent of the Minecraft version. */
    tools() {
      const out = {};
      for (const k of TOOL_KEYS) out[k] = this.data[k] || [];
      return out;
    }

    latestFabricLoader() {
      const list = newestFirst(this.data.fabricLoader, 'version');
      const stable = list.find((v) => v.stable);
      return (stable || list[0] || {}).version || '';
    }

    /** Mod Menu versions for a Minecraft version from Modrinth (lazy, cached). */
    async modMenuFor(id) {
      const known = this.data.modMenu[id];
      if (known) return known;
      const url = `${MODRINTH_API}/project/modmenu/version?game_versions=${encodeURIComponent(JSON.stringify([id]))}&loaders=${encodeURIComponent('["fabric"]')}`;
      const res = await fetchWithTimeout(url, 20000);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      const list = (json || [])
        .sort((a, b) => Date.parse(b.date_published) - Date.parse(a.date_published))
        .map((v) => ({ version: v.version_number, type: v.version_type }));
      this.data.modMenu[id] = list;
      saveCache(this.data);
      return list;
    }
  }

  /**
   * Resolve the catalog: fresh localStorage cache -> live fetch -> bundled data.
   * Returns { catalog, origin } with origin one of "cache" | "live" | "bundled" | "none".
   */
  async function load({ force = false, bundled = global.VERSION_DATA || null, timeoutMs } = {}) {
    const base = normalizeData(bundled, 'bundled');
    if (!force) {
      const cached = readCache();
      if (cached && Date.now() - Date.parse(cached.fetchedAt) < CACHE_TTL_MS) {
        return { catalog: new Catalog(merge(base, normalizeData(cached, 'cache'))), origin: 'cache' };
      }
    }
    const live = await fetchLive({ timeoutMs });
    const anyLive = LIST_KEYS.some((k) => live.sources[k].origin === 'live');
    const data = merge(base, live);
    if (anyLive) saveCache(data);
    const origin = anyLive ? 'live' : (base.minecraft.length ? 'bundled' : 'none');
    return { catalog: new Catalog(data), origin };
  }

  global.VersionCatalog = { load, fetchLive, Catalog, compareVersions, newestFirst, mcParts, isSupported, SOURCES, TOOL_KEYS, MIN_MINECRAFT, CACHE_KEY, normalizeData, merge };
})(typeof window !== 'undefined' ? window : globalThis);
