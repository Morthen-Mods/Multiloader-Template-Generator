/*
 * versions.js - live version catalog for the generator.
 *
 * Fetches the Minecraft version manifest plus the NeoForm / NeoForge / Forge / Fabric API /
 * Fabric Loader version lists (all endpoints allow browser requests), keeps only Minecraft
 * 26.1 and newer, and maps loader versions to a Minecraft version. Results are cached in
 * localStorage for an hour; window.VERSION_DATA (js/versions-data.js, produced by
 * scripts/bake-versions.py) is the offline / fetch-failure fallback.
 *
 *   const { catalog, origin } = await VersionCatalog.load();
 *   catalog.minecraftVersions({ snapshots: false })   // [{ id, type, releaseTime }]
 *   catalog.forMinecraft('26.2')                       // { neoform, neoforge, forge, fabricApi, fabricLoader }
 *   await catalog.javaFor('26.2')                      // 25
 *   await catalog.modMenuFor('26.2')                   // [{ version, type }]
 */
(function (global) {
  'use strict';

  const MIN_MAJOR = 26;                       // "26.1 and newer"
  const CACHE_KEY = 'modgen.versionCatalog.v2';
  const CACHE_TTL_MS = 60 * 60 * 1000;
  const MODRINTH_API = 'https://api.modrinth.com/v2';

  // group "minecraft": mapped per Minecraft version; group "tools": build tooling, independent of Minecraft.
  // cors:false sources cannot be fetched from a browser page; scripts/bake-versions.py fetches them with
  // web security disabled so they end up in the bundled catalog.
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
    modPublishPlugin:  { group: 'tools', label: 'mod-publish-plugin', url: 'https://plugins.gradle.org/m2/me/modmuss50/mod-publish-plugin/maven-metadata.xml', cors: false },
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

  const newestFirst = (list, key) => list.slice().sort((a, b) => compareVersions(key ? b[key] : b, key ? a[key] : a));
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /** "26.1.2" -> parts; "26.3-rc-1" -> tag "rc-1". Returns null for ids outside the year-based scheme. */
  function mcParts(id) {
    const m = String(id).match(/^(\d+)\.(\d+)(?:\.(\d+))?(?:-(.+))?$/);
    if (!m) return null;
    const patch = m[3] ? +m[3] : 0;
    return {
      major: +m[1], minor: +m[2], patch,
      tag: m[4] || null,
      base: m[3] ? `${m[1]}.${m[2]}.${m[3]}` : `${m[1]}.${m[2]}`,
      padded: `${m[1]}.${m[2]}.${patch}`,
    };
  }
  const isModern = (id) => { const p = mcParts(id); return !!p && p.major >= MIN_MAJOR; };

  // ---------------------------------------------------------------------------
  // parsers (one per source)
  // ---------------------------------------------------------------------------
  function parseMavenXml(text) {
    const out = [];
    const re = /<version>([^<]+)<\/version>/g;
    let m;
    while ((m = re.exec(text))) out.push(m[1].trim());
    return out;
  }

  const PARSERS = {
    minecraft: (json) => (json.versions || []).filter((v) => isModern(v.id))
      .map((v) => ({ id: v.id, type: v.type, releaseTime: v.releaseTime, url: v.url })),
    neoform: (json) => (json.versions || []).filter((v) => parseInt(v, 10) >= MIN_MAJOR),
    neoforge: (json) => (json.versions || []).filter((v) => parseInt(v, 10) >= MIN_MAJOR),
    forge: (text) => parseMavenXml(text).filter((v) => parseInt(v, 10) >= MIN_MAJOR),
    fabricApi: (text) => parseMavenXml(text).filter((v) => { const i = v.indexOf('+'); return i > 0 && parseInt(v.slice(i + 1), 10) >= MIN_MAJOR; }),
    fabricLoader: (json) => (json || []).map((v) => ({ version: v.version, stable: !!v.stable })),

    // build tooling (already sorted newest first)
    gradle: (json) => newestFirst((json || [])
      .filter((v) => !v.snapshot && !v.nightly && !v.releaseNightly && !v.rcFor && !v.milestoneFor && !v.broken && parseInt(v.version, 10) >= 8)
      .map((v) => v.version)),
    multiloaderPlugin: (json) => newestFirst(json.versions || []),
    moddev: (json) => newestFirst((json.versions || []).filter((v) => parseInt(v, 10) >= 2)).slice(0, 20),
    // Loom: final releases plus the rolling "<major>.<minor>-SNAPSHOT" lines the template uses
    loom: (text) => newestFirst(parseMavenXml(text).filter((v) => /-SNAPSHOT$/.test(v) || /^\d+\.\d+\.\d+$/.test(v))).slice(0, 20),
    forgeGradle: (text) => newestFirst(parseMavenXml(text)).slice(0, 20),
    modPublishPlugin: (text) => newestFirst(parseMavenXml(text).filter((v) => /^\d+\.\d+\.\d+$/.test(v))),
    foojay: (json) => newestFirst((json || []).map((t) => t.name || '')
      .filter((n) => n.startsWith('foojay-toolchains-plugin-'))
      .map((n) => n.slice('foojay-toolchains-plugin-'.length))),
  };
  const TEXT_SOURCES = new Set(['forge', 'fabricApi', 'loom', 'forgeGradle', 'modPublishPlugin']);

  // ---------------------------------------------------------------------------
  // data container
  // ---------------------------------------------------------------------------
  function emptyData() {
    const d = { fetchedAt: null, sources: {}, javaByMinecraft: {}, modMenu: {} };
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
    d.javaByMinecraft = Object.assign({}, raw.javaByMinecraft || {});
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
      else { d[k] = base[k]; d.sources[k] = { origin: (base.sources[k] || {}).origin || 'none', error: t.error, skipped: t.origin === 'skipped' }; }
    }
    d.javaByMinecraft = Object.assign({}, base.javaByMinecraft, top.javaByMinecraft);
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

  async function fetchLive({ timeoutMs = 20000, all = false } = {}) {
    const data = emptyData();
    data.fetchedAt = new Date().toISOString();
    await Promise.all(LIST_KEYS.map(async (key) => {
      if (SOURCES[key].cors === false && !all) { data[key] = []; data.sources[key] = { origin: 'skipped' }; return; }
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

    minecraftVersions({ snapshots = false } = {}) {
      return this.data.minecraft.filter((v) => snapshots || v.type === 'release');
    }

    hasMinecraft(id) { return this.data.minecraft.some((v) => v.id === id); }

    isSnapshot(id) {
      const v = this.data.minecraft.find((x) => x.id === id);
      return v ? v.type !== 'release' : !!(mcParts(id) || {}).tag;
    }

    /** Loader versions that target one Minecraft version, newest first. */
    forMinecraft(id) {
      const d = this.data;
      const out = { neoform: [], neoforge: [], forge: [], fabricApi: [], fabricLoader: newestFirst(d.fabricLoader, 'version') };
      const p = mcParts(id);
      if (!p) return out;

      // NeoForm: "<mc>-<n>" (e.g. 26.2-2, 26.3-rc-1-2)
      const nfRe = new RegExp('^' + escapeRe(id) + '-\\d+$');
      out.neoform = newestFirst(d.neoform.filter((v) => nfRe.test(v)));

      // NeoForge: releases "<major>.<minor>.<patch>.<build>[-beta]", snapshots "<major>.<minor>.<patch>.0-alpha.<n>+<tag>"
      const neoRe = p.tag
        ? new RegExp('^' + escapeRe(p.padded) + '\\.0-alpha\\.\\d+\\+' + escapeRe(p.tag) + '$')
        : new RegExp('^' + escapeRe(p.padded) + '\\.\\d+(-[A-Za-z]+)?$');
      out.neoforge = newestFirst(d.neoforge.filter((v) => neoRe.test(v)));

      // Forge: "<mc>-<forge version>", releases only
      out.forge = newestFirst(d.forge.filter((v) => v.startsWith(id + '-')).map((v) => v.slice(id.length + 1)));

      // Fabric API: "<api>+<mc>"; snapshot builds are tagged with the upcoming release ("+26.3")
      out.fabricApi = newestFirst(d.fabricApi.filter((v) => v.endsWith('+' + id)));
      if (!out.fabricApi.length && p.tag) out.fabricApi = newestFirst(d.fabricApi.filter((v) => v.endsWith('+' + p.base)));
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

    /** Required Java major version, from Mojang's per-version manifest (lazy, cached). */
    async javaFor(id) {
      const known = this.data.javaByMinecraft[id];
      if (known) return known;
      const entry = this.data.minecraft.find((v) => v.id === id);
      if (!entry || !entry.url) return null;
      const res = await fetchWithTimeout(entry.url, 20000);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      const major = json.javaVersion && json.javaVersion.majorVersion;
      if (!major) return null;
      this.data.javaByMinecraft[id] = major;
      saveCache(this.data);
      return major;
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

  global.VersionCatalog = { load, fetchLive, Catalog, compareVersions, newestFirst, mcParts, SOURCES, TOOL_KEYS, MIN_MAJOR, CACHE_KEY, normalizeData, merge };
})(typeof window !== 'undefined' ? window : globalThis);
