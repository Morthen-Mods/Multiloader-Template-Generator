/*
 * generator.js - pure, DOM-free transformation of the baked Multiloader-Template
 * snapshot (window.TEMPLATE_DATA) into a concrete mod project.
 *
 *   const cfg = ModGen.normalizeConfig(partialConfig, ModGen.uiDefaults(TEMPLATE_DATA));
 *   const errors = ModGen.validate(cfg);           // [] when fine
 *   const files = ModGen.generate(TEMPLATE_DATA, cfg); // [{ path, text|bytes, executable }]
 *   const blob = await ModGen.buildZip(files);        // needs JSZip on the page
 *
 * Everything in here is deliberately independent of the UI so that the same code
 * can be exercised by the headless test harness in tests/.
 */
(function (global) {
  'use strict';

  // ---------------------------------------------------------------------------
  // How a snapshot names its example mod (modId, modName, classPrefix, packageName,
  // packageDir). scripts/bake.py derives this from each branch, so an upstream rename
  // needs no code change here. Every snapshot carries its own description.
  // ---------------------------------------------------------------------------
  function templateOf(td) {
    const t = td && td.template;
    if (!t || !t.modId || !t.packageDir) throw new Error('snapshot has no template description; re-run scripts/bake.py');
    return t;
  }

  const SUBPROJECT_ORDER = ['common', 'datagen', 'fabric', 'forge', 'neoforge'];

  const JAVA_KEYWORDS = new Set(('abstract assert boolean break byte case catch char class const continue default do ' +
    'double else enum extends final finally float for goto if implements import instanceof int interface long native ' +
    'new package private protected public return short static strictfp super switch synchronized this throw throws ' +
    'transient try void volatile while true false null _').split(' '));

  const LICENSES = [
    { id: 'MIT', label: 'MIT', file: true },
    { id: 'Apache-2.0', label: 'Apache License 2.0', file: true },
    { id: 'MPL-2.0', label: 'Mozilla Public License 2.0', file: true },
    { id: 'LGPL-3.0-only', label: 'GNU LGPL v3', file: true },
    { id: 'GPL-3.0-only', label: 'GNU GPL v3', file: true },
    { id: 'ARR', label: 'All Rights Reserved', file: true },
    { id: 'NONE', label: 'No LICENSE file (add your own)', file: false },
  ];

  // Where the mod has to be installed: the plugin's ModSide for the Modrinth / CurseForge upload (withModPublish
  // side), mirrored into the loader metadata. Fabric's "server" means a dedicated server only, so a server-side mod
  // that also works in singleplayer stays "*". Forge reads clientSideOnly (mod file) and displayTest ([[mods]]) on
  // every supported version; NeoForge has neither key (a client-only NeoForge mod uses @Mod(dist = Dist.CLIENT)).
  const MOD_SIDES = [
    { id: 'CLIENT_AND_SERVER', label: 'Client and server', fabric: '*', forge: null },
    { id: 'CLIENT_ONLY', label: 'Client only', fabric: 'client', forge: { clientSideOnly: true } },
    { id: 'SERVER_ONLY', label: 'Server only (also in singleplayer)', fabric: '*', forge: { displayTest: 'IGNORE_SERVER_VERSION' } },
    { id: 'CLIENT_OR_SERVER', label: 'Client or server (optional on the other side)', fabric: '*', forge: { displayTest: 'IGNORE_ALL_VERSION' } },
  ];
  const DEFAULT_MOD_SIDE = 'CLIENT_AND_SERVER';
  // release type of the uploads (withModPublish type); ModPublishSpec has STABLE / BETA / ALPHA shortcuts
  const RELEASE_TYPES = [
    { id: 'STABLE', label: 'Release' },
    { id: 'BETA', label: 'Beta' },
    { id: 'ALPHA', label: 'Alpha' },
  ];
  const DEFAULT_RELEASE_TYPE = 'STABLE';

  // ---------------------------------------------------------------------------
  // Small utilities
  // ---------------------------------------------------------------------------
  const utf8 = new TextEncoder();

  function replaceAll(str, from, to) {
    return from ? str.split(from).join(to) : str;
  }

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function escapeJavaString(s) {
    return String(s)
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\r/g, '\\r')
      .replace(/\n/g, '\\n')
      .replace(/\t/g, '\\t');
  }

  /** Escape a value for a java.util.Properties file (which Gradle reads as ISO-8859-1). */
  function escapePropertiesValue(value) {
    const s = String(value);
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      const code = s.charCodeAt(i);
      if (ch === '\\') out += '\\\\';
      else if (ch === '\n') out += '\\n';
      else if (ch === '\r') out += '\\r';
      else if (ch === '\t') out += '\\t';
      else if (ch === '\f') out += '\\f';
      else if (i === 0 && ch === ' ') out += '\\ ';
      else if (code < 0x20 || code > 0x7e) out += '\\u' + code.toString(16).padStart(4, '0');
      else out += ch;
    }
    return out;
  }

  function parseProperties(text) {
    const map = {};
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || line.startsWith('!')) continue;
      const m = line.match(/^([^=:\s]+)\s*[=:]?\s*(.*)$/);
      if (m) map[m[1]] = m[2];
    }
    return map;
  }

  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /** Pure-JS SHA-1 (hex). Used for Minecraft's datagen .cache files; works without crypto.subtle (e.g. plain http). */
  function sha1Hex(bytes) {
    const total = Math.ceil((bytes.length + 9) / 64) * 64;
    const buf = new Uint8Array(total);
    buf.set(bytes);
    buf[bytes.length] = 0x80;
    const dv = new DataView(buf.buffer);
    const bitLen = bytes.length * 8;
    dv.setUint32(total - 8, Math.floor(bitLen / 0x100000000));
    dv.setUint32(total - 4, bitLen >>> 0);

    let h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476, h4 = 0xC3D2E1F0;
    const w = new Int32Array(80);
    for (let off = 0; off < total; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getInt32(off + i * 4);
      for (let i = 16; i < 80; i++) {
        const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
        w[i] = (x << 1) | (x >>> 31);
      }
      let a = h0, b = h1, c = h2, d = h3, e = h4;
      for (let i = 0; i < 80; i++) {
        let f, k;
        if (i < 20) { f = (b & c) | (~b & d); k = 0x5A827999; }
        else if (i < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
        else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
        else { f = b ^ c ^ d; k = 0xCA62C1D6; }
        const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) | 0;
        e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t;
      }
      h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
    }
    return [h0, h1, h2, h3, h4].map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('');
  }

  function localDateTimeNow() {
    const d = new Date();
    const p = (n, l = 2) => String(n).padStart(l, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}000`;
  }

  // ---------------------------------------------------------------------------
  // Minecraft version rules of the multiloader plugin (api/MinecraftVersion.kt):
  // release versions from 1.20.1 on; 1.20.1 is "legacy" (ModDevGradle Legacy with MCP,
  // no NeoForm, no NeoForge); below 26 the game is obfuscated (fabric-loom-remap).
  // ---------------------------------------------------------------------------
  const MIN_MINECRAFT = '1.20.1';
  // the first plugin release with the multiloaderSettings { } DSL the build scripts below are written in
  const MIN_PLUGIN_VERSION = '0.2.0';
  const RELEASE_RE = /^\d+\.\d+(\.\d+)?$/;

  /** Like the plugin: missing parts count as 0 ("1.21" == "1.21.0", "26" == "26.0.0"). */
  function compareMinecraft(a, b) {
    const parts = (v) => { const n = String(v).split('.').map((s) => parseInt(s, 10) || 0); return [n[0] || 0, n[1] || 0, n[2] || 0]; };
    const A = parts(a), B = parts(b);
    for (let i = 0; i < 3; i++) if (A[i] !== B[i]) return A[i] < B[i] ? -1 : 1;
    return 0;
  }
  const isRelease = (mc) => RELEASE_RE.test(String(mc || ''));
  const isSupportedMinecraft = (mc) => isRelease(mc) && compareMinecraft(mc, MIN_MINECRAFT) >= 0;
  const isLegacy = (mc) => compareMinecraft(mc, '1.20.2') < 0;
  const isObfuscated = (mc) => compareMinecraft(mc, '26') < 0;
  /** Java toolchain the plugin picks: below 1.20.5 -> 17, below 26 -> 21, otherwise 25. */
  function javaFor(mc) {
    if (compareMinecraft(mc, '26') >= 0) return 25;
    if (compareMinecraft(mc, '1.20.5') >= 0) return 21;
    return 17;
  }
  /** `common` compiles against NeoForm, except on 1.20.1 where it uses MCP. */
  const needsNeoform = (cfg) => !isLegacy(cfg.minecraftVersion);
  /** The neoforge project and (outside 1.20.1) the datagen project run on NeoForge. */
  const needsNeoforge = (cfg) => !isLegacy(cfg.minecraftVersion) && (!!cfg.loaders.neoforge || !!cfg.datagen);

  /** Numeric compare of the leading dotted part ("0.2.0-BETA" counts as 0.2.0). */
  function compareDotted(a, b) {
    const parts = (v) => (String(v).match(/^\d+(\.\d+)*/) || ['0'])[0].split('.').map(Number);
    const A = parts(a), B = parts(b);
    for (let i = 0; i < Math.max(A.length, B.length); i++) {
      const x = A[i] || 0, y = B[i] || 0;
      if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  }

  /**
   * Which template snapshot serves a Minecraft version. A template serves the version its
   * gradle.properties declares plus that version's patch releases ("26.1" serves 26.1.2): then
   * `covered` is true. Any other version gets the newest template that is not newer than it (or
   * the oldest one, for versions below every template) with `covered` false: the build setup is
   * still generated for the selected version, but the example sources target another one.
   */
  function resolveTemplate(manifest, mc) {
    const entries = (manifest && manifest.entries) || {};
    const fallback = { entry: entries.default || null, covered: false };
    const id = String(mc || '').trim();
    const list = Object.entries(entries).filter(([, e]) => e && isRelease(e.minecraftVersion));
    if (!isRelease(id) || !list.length) return fallback;
    // a dedicated version branch wins over the default branch declaring the same version
    const better = (a, b, newer) => {
      const c = compareMinecraft(a[1].minecraftVersion, b[1].minecraftVersion);
      if (c !== 0) return (newer ? c > 0 : c < 0) ? a : b;
      if (a[1].minecraftVersion.length !== b[1].minecraftVersion.length) return a[1].minecraftVersion.length > b[1].minecraftVersion.length ? a : b;
      return a[0] === 'default' ? b : a;
    };
    const covering = list.filter(([, e]) => id === e.minecraftVersion || id.startsWith(e.minecraftVersion + '.'));
    if (covering.length) return { entry: covering.reduce((a, b) => better(a, b, true))[1], covered: true };
    const older = list.filter(([, e]) => compareMinecraft(e.minecraftVersion, id) <= 0);
    const pick = older.length ? older.reduce((a, b) => better(a, b, true)) : list.reduce((a, b) => better(a, b, false));
    return { entry: pick[1], covered: false };
  }

  // ---------------------------------------------------------------------------
  // Suggestions for derived fields
  // ---------------------------------------------------------------------------
  function suggestModId(modName) {
    let id = String(modName || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    if (id && !/^[a-z]/.test(id)) id = 'mod_' + id;
    return id.slice(0, 64);
  }

  function suggestClassPrefix(modName, modId) {
    const words = String(modName || '').split(/[^A-Za-z0-9]+/).filter(Boolean);
    let s = words.map((w) => w[0].toUpperCase() + w.slice(1)).join('');
    if (!s) s = suggestModId(modId).split('_').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join('');
    s = s.replace(/^[0-9]+/, '');
    return s || 'Example';
  }

  function suggestRootProjectName(modName, modId) {
    let s = String(modName || '').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
    return s || modId || 'mod';
  }

  function suggestPackage(group, modId) {
    let seg = String(modId || '').toLowerCase().replace(/[^a-z0-9_]/g, '_');
    if (seg && !/^[a-z_]/.test(seg)) seg = '_' + seg;
    if (JAVA_KEYWORDS.has(seg)) seg = seg + '_';
    const g = String(group || '').trim().replace(/^\.+|\.+$/g, '');
    return [g, seg].filter(Boolean).join('.');
  }

  function suggestIssuesUrl(sourcesUrl) {
    const s = String(sourcesUrl || '').trim().replace(/\/+$/, '').replace(/\.git$/, '');
    if (/^https?:\/\/(www\.)?(github\.com|gitlab\.com|codeberg\.org)\/[^/]+\/[^/]+$/.test(s)) return s + '/issues';
    return '';
  }

  // ---------------------------------------------------------------------------
  // Defaults
  // ---------------------------------------------------------------------------
  /** Projects a settings script includes (include("a") or listOf("a", "b").forEach(::include)); null when it names none. */
  function settingsIncludes(settings) {
    const names = new Set();
    for (const line of String(settings || '').split('\n')) {
      if (/^\s*\/\//.test(line) || !/\binclude\b/.test(line)) continue;
      for (const m of line.matchAll(/"([^"]+)"/g)) names.add(m[1].replace(/^:/, ''));
    }
    return names.size ? names : null;
  }

  function templateDefaults(td) {
    const T = templateOf(td);
    const files = td.files || {};
    const text = (p) => (files[p] && typeof files[p].text === 'string') ? files[p].text : '';
    const props = parseProperties(text('gradle.properties'));
    const rootBuild = text('build.gradle.kts');
    const settings = text('settings.gradle.kts');
    const wrapper = text('gradle/wrapper/gradle-wrapper.properties');
    const fabricBuild = text('fabric/build.gradle.kts');

    const pluginVersion = (id, fallback) => {
      const re = new RegExp('id\\("' + escapeRegExp(id) + '"\\)\\s+version\\s+"([^"]+)"');
      const m = rootBuild.match(re) || settings.match(re);
      return m ? m[1] : fallback;
    };
    const gradleMatch = wrapper.match(/gradle-([0-9][^/-]*)-(?:bin|all)\.zip/);
    const modmenuMatch = fabricBuild.match(/com\.terraformersmc:modmenu:([^"')]+)/);
    const rootName = (settings.match(/rootProject\.name\s*=\s*"([^"]+)"/) || [])[1];
    // a branch still on the pre-0.2.0 DSL names an older plugin; the scripts written here need 0.2.0+
    let pluginDefault = pluginVersion('net.morthen.gradle.multiloader', '');
    if (pluginDefault && compareDotted(pluginDefault, MIN_PLUGIN_VERSION) < 0) pluginDefault = MIN_PLUGIN_VERSION;
    // the 0.2.0 DSL opts in with commonRunDirectory; older branches always kept their runs in common/runs
    const newDsl = /multiloaderSettings\s*\{/.test(rootBuild);
    const sideMatch = rootBuild.match(/\bside\s*=\s*ModSide\.([A-Z_]+)/);
    const typeMatch = rootBuild.match(/\btype\s*=\s*(?:ReleaseType\.)?(STABLE|BETA|ALPHA)\b/);
    const commonRuns = newDsl ? /commonRunDirectory\s*=\s*true/.test(rootBuild) : true;
    const mc = props.minecraft_version || '';
    // the projects the branch builds; a folder it keeps without including it (forge/ on 1.21.2) is not one of them
    const included = settingsIncludes(settings);
    const builds = (name) => !included || included.has(name);

    return {
      // identity
      modId: props.mod_id || T.modId,
      modName: props.mod_name || T.modName,
      modAuthor: props.mod_author || '',
      modDescription: props.mod_description || '',
      modLicense: props.mod_license || 'MIT',
      version: props.version || '0.0.1',
      group: props.group || 'net.example',
      basePackage: T.packageName,
      classPrefix: T.classPrefix,
      rootProjectName: rootName || 'Multiloader-Template',
      javaVersion: javaFor(mc),   // not a setting: the plugin derives it from the Minecraft version
      // versions
      minecraftVersion: mc,
      neoformVersion: props.neoform || '',
      neoforgeVersion: props.neoforge || '',
      fabricApiVersion: props.fabric_api || '',
      fabricLoaderVersion: props.fabric_loader || '',
      forgeVersion: props.forge || '',
      // loaders & features
      loaders: { fabric: builds('fabric'), forge: builds('forge'), neoforge: builds('neoforge') },
      datagen: builds('datagen'),
      gametest: true,
      testmod: true,
      mixins: true,
      modPublish: true,
      modrinthId: props.modrinth_id || '',
      curseforgeId: props.curseforge_id || '',
      releaseType: typeMatch ? typeMatch[1] : DEFAULT_RELEASE_TYPE,
      modSide: sideMatch && MOD_SIDES.some((s) => s.id === sideMatch[1]) ? sideMatch[1] : DEFAULT_MOD_SIDE,
      modMenu: !!modmenuMatch,
      modMenuVersion: modmenuMatch ? modmenuMatch[1] : '',
      // links
      sourcesUrl: props.sources_url || '',
      issuesUrl: props.issues_url || '',
      // output
      commonRunDirectory: commonRuns,
      // build tooling
      gradleVersion: gradleMatch ? gradleMatch[1] : '',
      jvmArgs: props['org.gradle.jvmargs'] || '-Xmx4096M',
      gradleDaemon: props['org.gradle.daemon'] !== 'false',
      multiloaderPluginVersion: pluginDefault,
      loomVersion: pluginVersion('net.fabricmc.fabric-loom', ''),
      forgeGradleVersion: pluginVersion('net.minecraftforge.gradle', ''),
      moddevVersion: pluginVersion('net.neoforged.moddev', ''),
      foojayVersion: pluginVersion('org.gradle.toolchains.foojay-resolver-convention', ''),
      // binary assets (Uint8Array or null)
      icon: null,
      banner: null,
    };
  }

  /** Defaults shown to a user: template versions/tooling, but no upstream identity. */
  function uiDefaults(td) {
    const d = templateDefaults(td);
    return Object.assign(d, {
      modId: 'example_mod',
      modName: 'Example Mod',
      modAuthor: '',
      modDescription: '',
      version: '1.0.0',
      group: 'com.example',
      basePackage: suggestPackage('com.example', 'example_mod'),
      classPrefix: suggestClassPrefix('Example Mod', 'example_mod'),
      rootProjectName: suggestRootProjectName('Example Mod', 'example_mod'),
      modrinthId: '',
      curseforgeId: '',
      sourcesUrl: '',
      issuesUrl: '',
      // every loader starts selected; the app switches off what the chosen Minecraft version has no build of
      loaders: { fabric: true, forge: true, neoforge: true },
      datagen: true,
    });
  }

  function normalizeConfig(partial, defaults) {
    const cfg = Object.assign({}, defaults, partial || {});
    cfg.loaders = Object.assign({}, defaults.loaders, (partial && partial.loaders) || {});
    for (const k of Object.keys(cfg)) {
      if (typeof defaults[k] === 'string' && typeof cfg[k] !== 'string') cfg[k] = cfg[k] == null ? '' : String(cfg[k]);
      if (typeof defaults[k] === 'boolean') cfg[k] = !!cfg[k];
    }
    for (const k of ['modId', 'modName', 'modAuthor', 'version', 'group', 'basePackage', 'classPrefix', 'rootProjectName',
      'minecraftVersion', 'neoformVersion', 'neoforgeVersion', 'fabricApiVersion', 'fabricLoaderVersion', 'forgeVersion',
      'modrinthId', 'curseforgeId', 'modMenuVersion', 'sourcesUrl', 'issuesUrl', 'gradleVersion', 'jvmArgs',
      'multiloaderPluginVersion', 'loomVersion', 'forgeGradleVersion', 'moddevVersion', 'foojayVersion']) {
      cfg[k] = cfg[k].trim();
    }
    // never a setting of its own: the plugin picks the toolchain from the Minecraft version
    cfg.javaVersion = javaFor(cfg.minecraftVersion);
    return cfg;
  }

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------
  const MOD_ID_RE = /^[a-z][a-z0-9_]{1,63}$/;          // intersection of Fabric / (Neo)Forge rules
  const PACKAGE_RE = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)*$/i;
  const CLASS_RE = /^[A-Z][A-Za-z0-9_]*$/;
  const PROJECT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

  function validate(cfg) {
    const errors = [];
    const err = (field, message) => errors.push({ field, message });
    const req = (field, label) => { if (!cfg[field]) err(field, `${label} is required.`); };

    req('modName', 'Mod name');
    // these values are substituted verbatim into fabric.mod.json / mods.toml by Gradle's expand(),
    // which does not escape quotes or line breaks, so they must not contain any
    for (const [field, label] of [['modName', 'Mod name'], ['modAuthor', 'Author'], ['modDescription', 'Description']]) {
      if (/["\\]/.test(cfg[field])) err(field, `${label} must not contain double quotes or backslashes.`);
      if (/[\r\n]/.test(cfg[field])) err(field, `${label} must be a single line.`);
    }
    if (!cfg.modId) err('modId', 'Mod ID is required.');
    else if (!MOD_ID_RE.test(cfg.modId)) err('modId', 'Mod ID must match [a-z][a-z0-9_]{1,63} (lowercase letters, digits, underscores; no hyphens because Forge/NeoForge reject them).');
    if (cfg.modId === 'minecraft' || cfg.modId === 'forge' || cfg.modId === 'neoforge' || cfg.modId === 'fabric') err('modId', `"${cfg.modId}" is reserved.`);

    req('version', 'Version');
    if (/\s/.test(cfg.version)) err('version', 'Version must not contain whitespace.');

    if (!cfg.group) err('group', 'Group is required.');
    else if (!PACKAGE_RE.test(cfg.group)) err('group', 'Group must be a valid Java package name (e.g. com.example).');

    if (!cfg.basePackage) err('basePackage', 'Base package is required.');
    else if (!PACKAGE_RE.test(cfg.basePackage)) err('basePackage', 'Base package must be a valid Java package name.');
    else {
      const bad = cfg.basePackage.split('.').find((s) => JAVA_KEYWORDS.has(s));
      if (bad) err('basePackage', `"${bad}" is a Java keyword and cannot be used as a package segment.`);
    }

    if (!cfg.classPrefix) err('classPrefix', 'Class prefix is required.');
    else if (!CLASS_RE.test(cfg.classPrefix)) err('classPrefix', 'Class prefix must be a valid Java class name starting with an uppercase letter.');

    if (!cfg.rootProjectName) err('rootProjectName', 'Project name is required.');
    else if (!PROJECT_NAME_RE.test(cfg.rootProjectName)) err('rootProjectName', 'Project name may only contain letters, digits, ".", "_" and "-".');

    // the plugin checks this as soon as it is applied
    if (!cfg.minecraftVersion) err('minecraftVersion', 'Minecraft version is required.');
    else if (!isRelease(cfg.minecraftVersion)) err('minecraftVersion', 'Only release versions are supported (no snapshots, pre-releases or release candidates).');
    else if (!isSupportedMinecraft(cfg.minecraftVersion)) err('minecraftVersion', `The multiloader plugin supports Minecraft ${MIN_MINECRAFT} and newer.`);
    if (needsNeoform(cfg)) req('neoformVersion', 'NeoForm version');
    if (cfg.loaders.fabric) { req('fabricApiVersion', 'Fabric API version'); req('fabricLoaderVersion', 'Fabric Loader version'); }
    if (cfg.loaders.forge) req('forgeVersion', 'Forge version');
    if (needsNeoforge(cfg)) req('neoforgeVersion', 'NeoForge version');
    if (cfg.loaders.fabric && cfg.modMenu) req('modMenuVersion', 'Mod Menu version');
    if (!cfg.loaders.fabric && !cfg.loaders.forge && !cfg.loaders.neoforge) err('loaders', 'Select at least one mod loader.');
    else if (cfg.loaders.neoforge && isSupportedMinecraft(cfg.minecraftVersion) && isLegacy(cfg.minecraftVersion)) {
      err('loaders', `NeoForge is not available for Minecraft ${cfg.minecraftVersion}; the plugin supports it from 1.20.2 on.`);
    }

    req('gradleVersion', 'Gradle version');
    if (!cfg.multiloaderPluginVersion) err('multiloaderPluginVersion', 'Multiloader plugin version is required.');
    else if (compareDotted(cfg.multiloaderPluginVersion, MIN_PLUGIN_VERSION) < 0) {
      err('multiloaderPluginVersion', `The generated build scripts need multiloader plugin ${MIN_PLUGIN_VERSION} or newer.`);
    }
    req('moddevVersion', 'ModDevGradle version');
    if (cfg.loaders.fabric) req('loomVersion', 'Fabric Loom version');
    if (cfg.loaders.forge) req('forgeGradleVersion', 'ForgeGradle version');
    req('foojayVersion', 'Foojay resolver version');

    for (const f of ['sourcesUrl', 'issuesUrl']) {
      if (cfg[f] && !/^https?:\/\/\S+$/.test(cfg[f])) err(f, 'Must be an http(s) URL.');
    }
    if (!LICENSES.some((l) => l.id === cfg.modLicense) && !cfg.modLicense) err('modLicense', 'License is required.');
    if (!MOD_SIDES.some((s) => s.id === cfg.modSide)) err('modSide', `Environment must be one of ${MOD_SIDES.map((s) => s.id).join(', ')}.`);
    if (!RELEASE_TYPES.some((t) => t.id === cfg.releaseType)) err('releaseType', `Release type must be one of ${RELEASE_TYPES.map((t) => t.id).join(', ')}.`);
    return errors;
  }

  // ---------------------------------------------------------------------------
  // Transformation
  // ---------------------------------------------------------------------------
  function makeContext(td, cfg) {
    return {
      T: templateOf(td),
      cfg,
      modId: cfg.modId,
      modName: cfg.modName,
      classPrefix: cfg.classPrefix,
      basePackage: cfg.basePackage,
      pkgPath: cfg.basePackage.replace(/\./g, '/'),
    };
  }

  /** Feature/loader filter on *template* paths. */
  function isIncluded(path, cfg) {
    const top = path.split('/')[0];
    if (path.startsWith('.idea/')) return false;
    if (top === 'fabric' && !cfg.loaders.fabric) return false;
    if (top === 'forge' && !cfg.loaders.forge) return false;
    if (top === 'neoforge' && !cfg.loaders.neoforge) return false;
    if (top === 'datagen' && !cfg.datagen) return false;
    if (!cfg.datagen && path.startsWith('common/src/generated/')) return false;
    if (!cfg.gametest && /^[^/]+\/src\/gametest\//.test(path)) return false;
    if (!cfg.testmod && /^[^/]+\/src\/testmod\//.test(path)) return false;
    if (!cfg.mixins && /\.mixins\.json$/.test(path)) return false;
    if (!cfg.commonRunDirectory && path.startsWith('common/runs/')) return false;
    return true;
  }

  function rewritePath(path, ctx) {
    const T = ctx.T;
    let p = path;
    p = replaceAll(p, T.packageDir, ctx.pkgPath + '/');
    p = replaceAll(p, T.packageName + '.', ctx.basePackage + '.'); // META-INF/services/<fqcn>
    p = p.replace(new RegExp('/' + T.classPrefix + '(Mod|Provider|Test)\\.java$'), `/${ctx.classPrefix}$1.java`);
    p = p.replace(new RegExp('/' + T.modId + '\\.mixins\\.json$'), `/${ctx.modId}.mixins.json`);
    p = p.replace(new RegExp('/' + T.modId + '\\.(fabric|forge|neoforge)\\.mixins\\.json$'), `/${ctx.modId}.$1.mixins.json`);
    p = p.replace(new RegExp('/' + T.modId + '\\.(classtweaker|accesswidener)$'), `/${ctx.modId}.$1`);
    p = replaceAll(p, `/data/${T.modId}/`, `/data/${ctx.modId}/`);
    p = replaceAll(p, `/data/${T.modId}_gametest/`, `/data/${ctx.modId}_gametest/`);
    p = p.replace(new RegExp('/' + T.modId + '(_banner)?\\.png$'), `/${ctx.modId}$1.png`);
    return p;
  }

  function modSide(cfg) {
    return MOD_SIDES.find((s) => s.id === cfg.modSide) || MOD_SIDES.find((s) => s.id === DEFAULT_MOD_SIDE);
  }

  /** clientSideOnly is a key of the mod file (before the first table), displayTest one of the [[mods]] entry. */
  function applyForgeSide(text, forge) {
    let t = text;
    if (forge.clientSideOnly) {
      if (/^clientSideOnly\s*=/m.test(t)) t = t.replace(/^clientSideOnly\s*=.*$/m, 'clientSideOnly = true');
      else t = t.replace(/\n(?:[ \t]*\n)*(?=\[)/, (gap) => '\nclientSideOnly = true' + gap);
    }
    if (forge.displayTest) {
      const line = `displayTest = "${forge.displayTest}"`;
      if (/^[ \t]*displayTest\s*=/m.test(t)) t = t.replace(/^([ \t]*)displayTest\s*=.*$/m, `$1${line}`);
      else {
        t = t.replace(/^\[\[mods\]\][^\n]*\n(?:[ \t]+\S[^\n]*\n)*/m, (block) => {
          const indent = (block.match(/\n([ \t]+)\S/) || [null, '    '])[1];
          return `${block}${indent}${line}\n`;
        });
      }
    }
    return t;
  }

  function rewriteText(path, text, ctx) {
    const { T, cfg, modId, modName, classPrefix, basePackage } = ctx;
    let t = text;
    t = replaceAll(t, T.packageName, basePackage);
    t = replaceAll(t, T.classPrefix + 'Mod', classPrefix + 'Mod');
    t = replaceAll(t, T.classPrefix + 'Provider', classPrefix + 'Provider');
    t = replaceAll(t, T.classPrefix + 'Test', classPrefix + 'Test');
    t = replaceAll(t, `MOD_NAME = "${T.modName}"`, `MOD_NAME = "${escapeJavaString(modName)}"`);
    t = replaceAll(t, `"${T.modName} Gametest"`, `"${escapeJavaString(modName + ' Gametest')}"`);
    t = replaceAll(t, `"${T.modName} Test Mod"`, `"${escapeJavaString(modName + ' Test Mod')}"`);
    t = replaceAll(t, `"${T.modName} Recipe Provider"`, `"${escapeJavaString(modName + ' Recipe Provider')}"`);
    t = replaceAll(t, `MOD_ID = "${T.modId}"`, `MOD_ID = "${modId}"`);
    t = replaceAll(t, `"${T.modId}:`, `"${modId}:`);
    t = replaceAll(t, `"${T.modId}_gametest:`, `"${modId}_gametest:`);
    // resource paths mentioned in sources or comments follow the renamed files (see rewritePath)
    t = replaceAll(t, `data/${T.modId}/`, `data/${modId}/`);
    t = replaceAll(t, `data/${T.modId}_gametest/`, `data/${modId}_gametest/`);

    if (path === 'common/runs/server/server.properties') {
      t = t.replace(new RegExp('^(initial-enabled-packs=.*),' + escapeRegExp(T.modId) + '$', 'm'), `$1,${modId}`);
      t = t.replace(/^management-server-secret=.*$/m, 'management-server-secret=');
    }
    const side = modSide(cfg);
    if (path === 'fabric/src/main/resources/fabric.mod.json') {
      t = t.replace(/("environment"\s*:\s*)"[^"]*"/, `$1"${side.fabric}"`);
    }
    if (path === 'forge/src/main/resources/META-INF/mods.toml' && side.forge) t = applyForgeSide(t, side.forge);
    if (!cfg.mixins) {
      if (/(^|\/)fabric\.mod\.json$/.test(path)) t = t.replace(/,\s*"mixins":\s*\[[^\]]*\]/, '');
      if (/neoforge\.mods\.toml$/.test(path)) t = t.replace(/\[\[mixins\]\]\s*\n\s*config\s*=\s*"[^"]*"\s*\n/g, '');
    }
    if (path === '.gitignore' && !cfg.commonRunDirectory) {
      // without commonRunDirectory every loader project keeps its game directories in <project>/runs
      t = t.replace(/\n*$/, '') + '\n/*/runs/\n';
    }
    return t;
  }

  // ----- files that are produced from scratch -------------------------------

  function genGradleProperties(cfg) {
    const L = [];
    L.push(`org.gradle.jvmargs=${escapePropertiesValue(cfg.jvmArgs || '-Xmx4096M')}`);
    L.push(`org.gradle.daemon=${cfg.gradleDaemon ? 'true' : 'false'}`);
    L.push('');
    L.push(`version=${escapePropertiesValue(cfg.version)}`);
    L.push(`group=${escapePropertiesValue(cfg.group)}`);
    L.push('');
    if (cfg.modPublish) {
      // the plugin uploads to a platform as soon as its key exists, even with an empty value,
      // so a platform without a project id only gets a commented-out key
      const id = (key, value) => (value ? `${key}=${escapePropertiesValue(value)}` : `#${key}=`);
      L.push(id('modrinth_id', cfg.modrinthId));
      L.push(id('curseforge_id', cfg.curseforgeId));
      L.push('');
    }
    L.push('# Common');
    L.push(`minecraft_version=${escapePropertiesValue(cfg.minecraftVersion)}`);
    L.push('');
    L.push(`mod_id=${cfg.modId}`);
    L.push(`mod_name=${escapePropertiesValue(cfg.modName)}`);
    L.push(`mod_author=${escapePropertiesValue(cfg.modAuthor)}`);
    L.push(`mod_license=${escapePropertiesValue(licenseLabelForProperties(cfg.modLicense))}`);
    L.push(`mod_description=${escapePropertiesValue(cfg.modDescription)}`);
    L.push('');
    if (needsNeoform(cfg)) L.push(`neoform=${escapePropertiesValue(cfg.neoformVersion)}`);
    if (needsNeoforge(cfg)) L.push(`neoforge=${escapePropertiesValue(cfg.neoforgeVersion)}`);
    if (cfg.loaders.fabric) {
      L.push(`fabric_api=${escapePropertiesValue(cfg.fabricApiVersion)}`);
      L.push(`fabric_loader=${escapePropertiesValue(cfg.fabricLoaderVersion)}`);
    }
    if (cfg.loaders.forge) L.push(`forge=${escapePropertiesValue(cfg.forgeVersion)}`);
    L.push('');
    L.push('# Additional stuff');
    L.push(`sources_url=${escapePropertiesValue(cfg.sourcesUrl)}`);
    L.push(`issues_url=${escapePropertiesValue(cfg.issuesUrl)}`);
    return L.join('\n') + '\n';
  }

  function licenseLabelForProperties(id) {
    // what ends up in fabric.mod.json / mods.toml "license" fields
    switch (id) {
      case 'ARR': return 'All Rights Reserved';
      case 'NONE': return 'ARR'; // no file shipped, but the loaders want a license string
      default: return id;
    }
  }

  function enabledSubprojects(cfg) {
    return SUBPROJECT_ORDER.filter((s) => s === 'common' || (s === 'datagen' ? cfg.datagen : cfg.loaders[s]));
  }

  function genSettings(cfg, td) {
    const original = (td.files['settings.gradle.kts'] || {}).text || '';
    // keep the upstream pluginManagement/plugins block verbatim when present, only patch name + includes
    let head = original.split(/rootProject\.name\s*=/)[0];
    if (!head.trim()) {
      head = `pluginManagement {
    repositories {
        gradlePluginPortal()
        mavenCentral()
        maven("https://maven.morthen.net/releases")

        maven("https://maven.neoforged.net/releases")
        maven("https://maven.minecraftforge.net")
        maven("https://maven.fabricmc.net")
    }
}

plugins {
    id("org.gradle.toolchains.foojay-resolver-convention") version "${cfg.foojayVersion}"
}

`;
    }
    head = head.replace(/(id\("org\.gradle\.toolchains\.foojay-resolver-convention"\)\s+version\s+")[^"]+(")/, `$1${cfg.foojayVersion}$2`);
    const includes = enabledSubprojects(cfg).map((s) => `"${s}"`).join(', ');
    return `${head}rootProject.name = "${cfg.rootProjectName}"\n\nlistOf(${includes}).forEach(::include)\n`;
  }

  // metadata files that get ${...} placeholders, in this order; only those the project contains are listed
  const METADATA_PATTERNS = [
    ['pack.mcmeta', /^[^/]+\/src\/[^/]+\/resources\/pack\.mcmeta$/],
    ['*.mixins.json', /^[^/]+\/src\/[^/]+\/resources\/[^/]+\.mixins\.json$/],
    ['fabric.mod.json', /^[^/]+\/src\/[^/]+\/resources\/fabric\.mod\.json$/],
    ['META-INF/mods.toml', /^[^/]+\/src\/[^/]+\/resources\/META-INF\/mods\.toml$/],
    ['META-INF/neoforge.mods.toml', /^[^/]+\/src\/[^/]+\/resources\/META-INF\/neoforge\.mods\.toml$/],
  ];

  /** Minecraft only accepts player names of 3-16 letters, digits and underscores. */
  const PLAYER_NAME_RE = /^[A-Za-z0-9_]{3,16}$/;

  function genRootBuild(cfg, paths) {
    const P = [];
    P.push(`    id("net.morthen.gradle.multiloader") version "${cfg.multiloaderPluginVersion}"`);
    P.push('');
    if (cfg.loaders.fabric) P.push(`    id("net.fabricmc.fabric-loom") version "${cfg.loomVersion}" apply false`);
    if (cfg.loaders.forge) P.push(`    id("net.minecraftforge.gradle") version "${cfg.forgeGradleVersion}" apply false`);
    P.push(`    id("net.neoforged.moddev") version "${cfg.moddevVersion}" apply false`);

    const sections = [];
    const features = [];
    if (cfg.testmod) features.push('    withTestmod()');
    if (cfg.gametest) features.push('    withGametest()');
    if (cfg.commonRunDirectory) features.push('    // Game directories of all runs live in common/runs', '    commonRunDirectory = true');
    sections.push(features);

    const patterns = METADATA_PATTERNS.filter(([, re]) => paths.some((p) => re.test(p))).map(([glob]) => `"${glob}"`);
    const props = [];
    if (cfg.loaders.fabric) props.push('"fabric_api" to fabricApiVersion', '"fabric_loader" to fabricLoaderVersion');
    if (cfg.loaders.forge) props.push('"forge_version" to forgeVersion');
    if (needsNeoforge(cfg)) props.push('"neoforge_version" to neoforgeVersion');
    props.push('"sources_url" to providers.gradleProperty("sources_url")', '"issues_url" to providers.gradleProperty("issues_url")');
    sections.push([
      '    applyMetadataReplacements(',
      `        listOf(${patterns.join(', ')}),`,
      '        mapOf(',
      props.map((p) => `            ${p}`).join(',\n'),
      '        )',
      '    )',
    ]);

    const client = ['        register("client") {', '            client()'];
    // the author doubles as the dev player name, as long as Minecraft would accept it as one
    if (PLAYER_NAME_RE.test(cfg.modAuthor)) client.push('            programArgs("--username", modAuthor.get())');
    client.push('            loadedMods.add(modId)', '        }');
    sections.push([
      '    runs {',
      ...client,
      '        register("server") {',
      '            server()',
      '            loadedMods.add(modId)',
      '        }',
      '    }',
    ]);

    const imports = [];
    if (cfg.modPublish) {
      const spec = [];
      if (cfg.releaseType !== DEFAULT_RELEASE_TYPE) spec.push(`        type = ${cfg.releaseType}`);
      if (cfg.modSide !== DEFAULT_MOD_SIDE) {
        imports.push('import net.morthen.gradle.multiloader.api.ModSide');
        spec.push(`        side = ModSide.${cfg.modSide}`);
      }
      const deps = [];
      if (cfg.loaders.fabric) {
        deps.push('        dependencies {', '            fabric {', '                requires("fabric-api")');
        if (cfg.modMenu) deps.push('                optional("modmenu")');
        deps.push('            }', '        }');
      }
      const inner = [spec, deps].filter((b) => b.length).map((b) => b.join('\n')).join('\n\n');
      sections.push(['    // Uploads to CurseForge (curseforge_id) and Modrinth (modrinth_id)',
        inner ? `    withModPublish {\n${inner}\n    }` : '    withModPublish { }']);
    }

    const body = sections.filter((s) => s.length).map((s) => s.join('\n')).join('\n\n');
    return (imports.length ? imports.join('\n') + '\n\n' : '') + `plugins {\n${P.join('\n')}\n}\n\n`
      + '// Shared settings for every subproject. Mod info and loader versions are read from gradle.properties.\n'
      + `multiloaderSettings {\n${body}\n}\n`;
  }

  function subprojectBuild(loader, extraImports, body) {
    const imports = ['import net.morthen.gradle.multiloader.api.Loader', ...extraImports].join('\n');
    const lines = [`    loader = Loader.${loader}`];
    if (body.length) lines.push('', ...body);
    return `${imports}\n\nplugins {\n    id("net.morthen.gradle.multiloader")\n}\n\nmultiloader {\n${lines.join('\n')}\n}\n`;
  }

  function genCommonBuild() {
    return subprojectBuild('COMMON', [], []);
  }

  function genDatagenBuild() {
    return subprojectBuild('DATAGEN', [], []);
  }

  /** The Fabric access modifier file the project ships, looked up the way the plugin does (common first). */
  function fabricModifier(cfg, paths) {
    for (const [ext, type] of [['classtweaker', 'CLASS_TWEAKER'], ['accesswidener', 'ACCESS_WIDENER']]) {
      const name = `${cfg.modId}.${ext}`;
      const re = new RegExp(`^(common|fabric)/src/main/resources/(META-INF/)?${escapeRegExp(name)}$`);
      if (paths.some((p) => re.test(p))) return { name, type };
    }
    return null;
  }

  function genFabricBuild(cfg, paths) {
    const modifier = fabricModifier(cfg, paths);
    const body = modifier ? [`    // ${modifier.name}, from common or fabric`, `    modifierType = ModifierType.${modifier.type}`] : [];
    let out = subprojectBuild('FABRIC', modifier ? ['import net.morthen.gradle.multiloader.api.ModifierType'] : [], body);
    if (cfg.modMenu) {
      const dependency = `"com.terraformersmc:modmenu:${cfg.modMenuVersion}"`;
      if (!isObfuscated(cfg.minecraftVersion)) {
        out += `\ndependencies {\n    implementation(${dependency})\n}\n`;
      } else {
        // Below 26 the game is obfuscated and mod dependencies go through Loom's remapping configurations.
        // The plugin applies fabric-loom-remap in its own afterEvaluate, so they do not exist yet while this
        // script runs; an afterEvaluate registered here runs after the plugin's (the template's 1.21.x branches)
        out += `\nafterEvaluate {\n    dependencies {\n        "modImplementation"(${dependency})\n    }\n}\n`;
      }
    }
    return out;
  }

  function genForgeBuild(cfg) {
    const body = cfg.mixins ? [
      '    // Forge reads the mixin configs from the jar manifest and the run arguments',
      '    mixins = listOf(',
      '        "$modId.mixins.json",',
      '        "$modId.forge.mixins.json"',
      '    )',
    ] : [];
    return subprojectBuild('FORGE', [], body);
  }

  function genNeoForgeBuild() {
    return subprojectBuild('NEOFORGE', [], []);
  }

  function genWrapperProperties(cfg, td) {
    const original = (td.files['gradle/wrapper/gradle-wrapper.properties'] || {}).text || '';
    if (original && /distributionUrl=/.test(original)) {
      return original.replace(/(distributionUrl=.*gradle-)[^/]*?(-(?:bin|all)\.zip)/, `$1${cfg.gradleVersion}$2`);
    }
    return `distributionBase=GRADLE_USER_HOME\ndistributionPath=wrapper/dists\ndistributionUrl=https\\://services.gradle.org/distributions/gradle-${cfg.gradleVersion}-bin.zip\nnetworkTimeout=10000\nvalidateDistributionUrl=true\nzipStoreBase=GRADLE_USER_HOME\nzipStorePath=wrapper/dists\n`;
  }

  function genLicense(cfg, licenseData) {
    const year = new Date().getFullYear();
    const holder = cfg.modAuthor || cfg.modName;
    switch (cfg.modLicense) {
      case 'NONE':
        return null;
      case 'MIT':
        return `MIT License

Copyright (c) ${year} ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
      case 'ARR':
        return `Copyright (c) ${year} ${holder}. All rights reserved.

This software and its source code are the property of the copyright holder.
No permission is granted to use, copy, modify, merge, publish, distribute,
sublicense or sell copies of this software, in whole or in part, without the
prior written consent of the copyright holder.
`;
      default: {
        const text = licenseData && licenseData[cfg.modLicense];
        if (!text) return `${cfg.modLicense}\n\nCopyright (c) ${year} ${holder}\n`;
        return text.endsWith('\n') ? text : text + '\n';
      }
    }
  }

  function genChangelog(cfg) {
    return `## v${cfg.version}\n`;
  }

  function genReadme(cfg, td) {
    const loaders = [];
    if (cfg.loaders.fabric) loaders.push('Fabric');
    if (cfg.loaders.forge) loaders.push('Forge');
    if (cfg.loaders.neoforge) loaders.push('NeoForge');
    const src = (td.source || 'https://github.com/Morthen-Mods/Multiloader-Template').replace(/\.git$/, '');
    const L = [];
    L.push(`# ${cfg.modName}`);
    L.push('');
    if (cfg.modDescription) { L.push(cfg.modDescription); L.push(''); }
    L.push(`Multiloader Minecraft mod for **${loaders.join(', ')}** on Minecraft **${cfg.minecraftVersion}**.`);
    L.push(`Generated from the [Multiloader Template](${src}), which builds on the [multiloader-gradle-plugin](https://github.com/Morthen-Mods/multiloader-gradle-plugin).`);
    L.push('');
    L.push('## Requirements');
    L.push('');
    if (cfg.javaVersion >= 25) {
      L.push(`- JDK ${cfg.javaVersion} (Gradle's toolchain support downloads one automatically if it is missing)`);
    } else {
      // the mod compiles against an older toolchain, but Gradle itself has to run on a JDK the build plugins accept
      L.push(`- JDK ${cfg.loaders.fabric ? '25 to run Gradle (Fabric Loom needs it)' : '17 or newer to run Gradle'}; the JDK ${cfg.javaVersion} toolchain the mod is compiled with is downloaded automatically if it is missing`);
    }
    L.push('- Git');
    L.push('');
    L.push('## Project layout');
    L.push('');
    L.push('| Module | Purpose |');
    L.push('| --- | --- |');
    L.push('| `common` | Loader-independent code and resources. Compiled into every loader jar. |');
    if (cfg.datagen) L.push(`| \`datagen\` | Data generators (run on ${isLegacy(cfg.minecraftVersion) ? 'ModDevGradle Legacy' : 'NeoForge'}). Output is written to \`common/src/generated\`. |`);
    if (cfg.loaders.fabric) L.push('| `fabric` | Fabric entrypoint, `fabric.mod.json` and Fabric-only code. |');
    if (cfg.loaders.forge) L.push('| `forge` | Forge entrypoint, `mods.toml` and Forge-only code. |');
    if (cfg.loaders.neoforge) L.push('| `neoforge` | NeoForge entrypoint, `neoforge.mods.toml` and NeoForge-only code. |');
    L.push('');
    L.push('Loader-specific behaviour is accessed from common code through the `IPlatformHelper` service');
    L.push(`(\`${cfg.basePackage}.service.Services.PLATFORM\`).`);
    L.push('');
    L.push('## Building');
    L.push('');
    L.push('```');
    L.push('./gradlew build');
    L.push('```');
    L.push('');
    L.push('The mod jars end up in `<loader>/build/libs/`.');
    L.push('');
    L.push('## Running');
    L.push('');
    L.push('Run configurations are generated for IntelliJ IDEA; on the command line use the Gradle tasks below.');
    L.push(cfg.commonRunDirectory ? 'Game directories live in `common/runs/`.' : 'Game directories live in `<project>/runs/`.');
    L.push('');
    L.push('| Task | Description |');
    L.push('| --- | --- |');
    if (cfg.loaders.fabric) L.push('| `:fabric:runClient` / `:fabric:runServer` | Fabric client / server |');
    if (cfg.loaders.forge) L.push('| `:forge:runClient` / `:forge:runServer` | Forge client / server |');
    if (cfg.loaders.neoforge) L.push('| `:neoforge:runClient` / `:neoforge:runServer` | NeoForge client / server |');
    if (cfg.testmod) L.push('| `:<loader>:runTestmodClient` / `runTestmodServer` | Same, with the `testmod` source set loaded as a second mod |');
    if (cfg.gametest) {
      if (cfg.loaders.fabric) L.push('| `:fabric:runGameTests` | Run the game tests on Fabric |');
      if (cfg.loaders.forge) L.push('| `:forge:runGametestGameTestServer` | Run the game tests on Forge (generates test instances via `:forge:runGametestData` first) |');
      if (cfg.loaders.neoforge) L.push('| `:neoforge:runGameTests` | Run the game tests on NeoForge |');
    }
    if (cfg.datagen) L.push('| `:datagen:runData` | Run data generation; writes into `common/src/generated` |');
    L.push('');
    if (cfg.modPublish) {
      L.push('## Publishing');
      L.push('');
      L.push('Publishing uses [mod-publish-plugin](https://github.com/modmuss50/mod-publish-plugin).');
      L.push('Set the `MODRINTH_API` and/or `CURSEFORGE_API` environment variables (and the matching');
      L.push('`modrinth_id` / `curseforge_id` in `gradle.properties`), then run:');
      L.push('');
      L.push('```');
      L.push('./gradlew publishMods');
      L.push('```');
      L.push('');
      L.push('A platform is used as soon as its `modrinth_id` / `curseforge_id` entry exists in `gradle.properties`,');
      L.push('so leave the entry of a platform you don\'t publish to commented out. `CHANGELOG.md` is used as the release changelog.');
      L.push('Add `-Pmod_publish_dry_run=true` to test the upload without publishing anything.');
      L.push('');
    }
    if (cfg.modLicense !== 'NONE') {
      L.push('## License');
      L.push('');
      L.push(cfg.modLicense === 'ARR' ? 'All rights reserved. See `LICENSE`.' : `This project is licensed under the ${cfg.modLicense} license. See \`LICENSE\`.`);
      L.push('');
    }
    return L.join('\n');
  }

  // ----- main entry ---------------------------------------------------------

  /**
   * Returns an array of output entries: { path, text?, bytes?, executable }.
   * `path` is relative to the project root, which is also the ZIP root.
   */
  function generate(td, cfg) {
    const ctx = makeContext(td, cfg);
    const out = new Map();
    const put = (path, entry, { replace = false } = {}) => {
      if (entry === null || entry === undefined) return;
      if (out.has(path) && !replace) throw new Error(`Output path collision: ${path}`);
      out.set(path, Object.assign({ path, executable: false }, entry));
    };

    const REGENERATED = new Set([
      'gradle.properties', 'settings.gradle.kts', 'build.gradle.kts', 'LICENSE', 'README.md', 'CHANGELOG.md',
      'gradle/wrapper/gradle-wrapper.properties',
      'common/build.gradle.kts', 'datagen/build.gradle.kts', 'fabric/build.gradle.kts', 'forge/build.gradle.kts', 'neoforge/build.gradle.kts',
    ]);
    const cacheFiles = [];

    for (const [path, file] of Object.entries(td.files)) {
      if (!isIncluded(path, cfg)) continue;
      if (REGENERATED.has(path)) continue;
      if (/\/\.cache\/[0-9a-f]{40}$/.test(path)) { cacheFiles.push(path); continue; }

      const newPath = rewritePath(path, ctx);
      if (typeof file.text === 'string') {
        put(newPath, { text: rewriteText(path, file.text, ctx), executable: newPath === 'gradlew' });
      } else {
        put(newPath, { bytes: b64ToBytes(file.base64), executable: false });
      }
    }

    // regenerated top-level files; the build scripts look at which files the project ended up with
    const paths = Array.from(out.keys());
    put('gradle.properties', { text: genGradleProperties(cfg) });
    put('settings.gradle.kts', { text: genSettings(cfg, td) });
    put('build.gradle.kts', { text: genRootBuild(cfg, paths) });
    put('gradle/wrapper/gradle-wrapper.properties', { text: genWrapperProperties(cfg, td) });
    put('README.md', { text: genReadme(cfg, td) });
    put('CHANGELOG.md', { text: genChangelog(cfg) });
    const license = genLicense(cfg, td.licenses || global.LICENSE_DATA);
    if (license) put('LICENSE', { text: license });

    put('common/build.gradle.kts', { text: genCommonBuild() });
    if (cfg.datagen) put('datagen/build.gradle.kts', { text: genDatagenBuild() });
    if (cfg.loaders.fabric) put('fabric/build.gradle.kts', { text: genFabricBuild(cfg, paths) });
    if (cfg.loaders.forge) put('forge/build.gradle.kts', { text: genForgeBuild(cfg) });
    if (cfg.loaders.neoforge) put('neoforge/build.gradle.kts', { text: genNeoForgeBuild() });

    // optional binary assets referenced by the loader metadata files
    // the template ships placeholder artwork; an upload takes its place
    if (cfg.icon) put(`common/src/main/resources/${cfg.modId}.png`, { bytes: cfg.icon }, { replace: true });
    if (cfg.banner) put(`common/src/main/resources/${cfg.modId}_banner.png`, { bytes: cfg.banner }, { replace: true });

    // Minecraft datagen caches: "<sha1 of provider name>" file with "// <mc>\t<time>\t<provider>" header
    // followed by "<sha1 of content> <relative path>" lines. Recompute for the renamed files.
    const timestamp = localDateTimeNow();
    for (const path of cacheFiles) {
      const base = path.replace(/\/\.cache\/[0-9a-f]{40}$/, '');
      const lines = td.files[path].text.split(/\r?\n/);
      const header = lines[0].startsWith('// ') ? lines[0].slice(3).split('\t') : [];
      const providerName = rewriteProviderName(header[2] || header[header.length - 1] || '', ctx);
      const entries = [];
      for (const line of lines.slice(1)) {
        const m = line.match(/^([0-9a-f]{40}) (.+)$/);
        if (!m) continue;
        const rel = rewritePath(base + '/' + m[2], ctx).slice(base.length + 1);
        const target = out.get(base + '/' + rel);
        if (!target) continue;
        entries.push(`${sha1Hex(entryBytes(target))} ${rel}`);
      }
      entries.sort((a, b) => (a.slice(41) < b.slice(41) ? -1 : 1));
      const text = `// ${cfg.minecraftVersion}\t${timestamp}\t${providerName}\n${entries.join('\n')}\n`;
      put(`${base}/.cache/${sha1Hex(utf8.encode(providerName))}`, { text });
    }

    return Array.from(out.values()).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  /**
   * Datagen provider names as they appear in .cache headers (unquoted, so rewriteText() does not cover them),
   * e.g. "Example Mod Recipe Provider", "Tags for minecraft:item mod id example_mod",
   * "Registries for Reloadable (example_mod[0]): [example_mod]", "example_mod-global/Tags for ...".
   * The mod id is replaced wherever it stands on its own or before a suffix such as "_gametest".
   */
  function rewriteProviderName(name, ctx) {
    const T = ctx.T;
    let n = name.replace(new RegExp(escapeRegExp(T.modName) + '(?= |$)', 'g'), ctx.modName);
    n = n.replace(new RegExp('(^|[^a-z0-9_])' + escapeRegExp(T.modId) + '(?![a-z0-9])', 'g'), `$1${ctx.modId}`);
    return n;
  }

  function entryBytes(entry) {
    return entry.bytes ? entry.bytes : utf8.encode(entry.text);
  }

  async function buildZip(files) {
    if (typeof global.JSZip === 'undefined') throw new Error('JSZip is not loaded');
    const zip = new global.JSZip();
    const date = new Date();
    for (const f of files) {
      // the project sits at the archive root; extractors that need a folder create one themselves
      zip.file(f.path, f.bytes ? f.bytes : f.text, {
        binary: !!f.bytes,
        date,
        unixPermissions: f.executable ? 0o755 : 0o644,
      });
    }
    return zip.generateAsync({ type: 'blob', platform: 'UNIX', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  }

  global.ModGen = {
    LICENSES, MOD_SIDES, RELEASE_TYPES, JAVA_KEYWORDS, MIN_MINECRAFT, MIN_PLUGIN_VERSION, templateOf, resolveTemplate,
    templateDefaults, uiDefaults, normalizeConfig, validate, generate, buildZip,
    suggestModId, suggestClassPrefix, suggestRootProjectName, suggestPackage, suggestIssuesUrl,
    compareMinecraft, isRelease, isSupportedMinecraft, isLegacy, isObfuscated, javaFor, needsNeoform, needsNeoforge,
    enabledSubprojects, sha1Hex, entryBytes, escapePropertiesValue, parseProperties,
  };
})(typeof window !== 'undefined' ? window : globalThis);
