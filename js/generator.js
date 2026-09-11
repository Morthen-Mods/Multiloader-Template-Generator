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
  // Constants describing the *template* (the thing we transform away from).
  // If the upstream template renames its example mod, update these.
  // ---------------------------------------------------------------------------
  const T = {
    modId: 'example_mod',
    modName: 'Example Mod',
    classPrefix: 'ExampleMod',          // upstream classes: ExampleModMod, ExampleModProvider, ExampleModTest
    packageDir: 'com/example/example_mod/',
    packageName: 'com.example.example_mod',
  };

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
  function templateDefaults(td) {
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
      javaVersion: parseInt(props.java_version, 10) || 25,
      // versions
      minecraftVersion: props.minecraft_version || '',
      neoformVersion: props.neoform || '',
      neoforgeVersion: props.neoforge || '',
      fabricApiVersion: props.fabric_api || '',
      fabricLoaderVersion: props.fabric_loader || '',
      forgeVersion: props.forge || '',
      // loaders & features
      loaders: { fabric: true, forge: true, neoforge: true },
      datagen: true,
      gametest: true,
      testmod: true,
      mixins: true,
      modPublish: true,
      modrinthId: props.modrinth_id || '',
      curseforgeId: props.curseforge_id || '',
      modMenu: !!modmenuMatch,
      modMenuVersion: modmenuMatch ? modmenuMatch[1] : '',
      // links
      sourcesUrl: props.sources_url || '',
      issuesUrl: props.issues_url || '',
      // output
      includeRunDefaults: true,
      // build tooling
      gradleVersion: gradleMatch ? gradleMatch[1] : '',
      jvmArgs: props['org.gradle.jvmargs'] || '-Xmx4096M',
      gradleDaemon: props['org.gradle.daemon'] !== 'false',
      multiloaderPluginVersion: pluginVersion('net.morthen.gradle.multiloader', ''),
      loomVersion: pluginVersion('net.fabricmc.fabric-loom', ''),
      forgeGradleVersion: pluginVersion('net.minecraftforge.gradle', ''),
      moddevVersion: pluginVersion('net.neoforged.moddev', ''),
      modPublishPluginVersion: pluginVersion('me.modmuss50.mod-publish-plugin', ''),
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
    });
  }

  function normalizeConfig(partial, defaults) {
    const cfg = Object.assign({}, defaults, partial || {});
    cfg.loaders = Object.assign({}, defaults.loaders, (partial && partial.loaders) || {});
    for (const k of Object.keys(cfg)) {
      if (typeof defaults[k] === 'string' && typeof cfg[k] !== 'string') cfg[k] = cfg[k] == null ? '' : String(cfg[k]);
      if (typeof defaults[k] === 'boolean') cfg[k] = !!cfg[k];
    }
    cfg.javaVersion = parseInt(cfg.javaVersion, 10) || defaults.javaVersion;
    for (const k of ['modId', 'modName', 'modAuthor', 'version', 'group', 'basePackage', 'classPrefix', 'rootProjectName',
      'minecraftVersion', 'neoformVersion', 'neoforgeVersion', 'fabricApiVersion', 'fabricLoaderVersion', 'forgeVersion',
      'modrinthId', 'curseforgeId', 'modMenuVersion', 'sourcesUrl', 'issuesUrl', 'gradleVersion', 'jvmArgs',
      'multiloaderPluginVersion', 'loomVersion', 'forgeGradleVersion', 'moddevVersion', 'modPublishPluginVersion', 'foojayVersion']) {
      cfg[k] = cfg[k].trim();
    }
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

    if (!(cfg.javaVersion >= 17 && cfg.javaVersion <= 99)) err('javaVersion', 'Java version must be a number between 17 and 99.');
    req('minecraftVersion', 'Minecraft version');
    req('neoformVersion', 'NeoForm version');
    if (cfg.loaders.fabric) { req('fabricApiVersion', 'Fabric API version'); req('fabricLoaderVersion', 'Fabric Loader version'); }
    if (cfg.loaders.forge) req('forgeVersion', 'Forge version');
    if (cfg.loaders.neoforge || cfg.datagen) req('neoforgeVersion', 'NeoForge version');
    if (cfg.loaders.fabric && cfg.modMenu) req('modMenuVersion', 'Mod Menu version');
    if (!cfg.loaders.fabric && !cfg.loaders.forge && !cfg.loaders.neoforge) err('loaders', 'Select at least one mod loader.');

    req('gradleVersion', 'Gradle version');
    req('multiloaderPluginVersion', 'Multiloader plugin version');
    req('moddevVersion', 'ModDevGradle version');
    if (cfg.loaders.fabric) req('loomVersion', 'Fabric Loom version');
    if (cfg.loaders.forge) req('forgeGradleVersion', 'ForgeGradle version');
    if (cfg.modPublish) req('modPublishPluginVersion', 'mod-publish-plugin version');
    req('foojayVersion', 'Foojay resolver version');

    for (const f of ['sourcesUrl', 'issuesUrl']) {
      if (cfg[f] && !/^https?:\/\/\S+$/.test(cfg[f])) err(f, 'Must be an http(s) URL.');
    }
    if (!LICENSES.some((l) => l.id === cfg.modLicense) && !cfg.modLicense) err('modLicense', 'License is required.');
    return errors;
  }

  // ---------------------------------------------------------------------------
  // Transformation
  // ---------------------------------------------------------------------------
  function makeContext(cfg) {
    return {
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
    if (!cfg.includeRunDefaults && path.startsWith('common/runs/')) return false;
    return true;
  }

  function rewritePath(path, ctx) {
    let p = path;
    p = replaceAll(p, T.packageDir, ctx.pkgPath + '/');
    p = replaceAll(p, T.packageName + '.', ctx.basePackage + '.'); // META-INF/services/<fqcn>
    p = p.replace(new RegExp('/' + T.classPrefix + '(Mod|Provider|Test)\\.java$'), `/${ctx.classPrefix}$1.java`);
    p = p.replace(new RegExp('/' + T.modId + '\\.mixins\\.json$'), `/${ctx.modId}.mixins.json`);
    p = p.replace(new RegExp('/' + T.modId + '\\.(fabric|forge|neoforge)\\.mixins\\.json$'), `/${ctx.modId}.$1.mixins.json`);
    p = p.replace(new RegExp('/' + T.modId + '\\.classtweaker$'), `/${ctx.modId}.classtweaker`);
    p = replaceAll(p, `/data/${T.modId}/`, `/data/${ctx.modId}/`);
    p = replaceAll(p, `/data/${T.modId}_gametest/`, `/data/${ctx.modId}_gametest/`);
    return p;
  }

  function rewriteText(path, text, ctx) {
    const { cfg, modId, modName, classPrefix, basePackage } = ctx;
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

    if (path === 'common/runs/server/server.properties') {
      t = t.replace(new RegExp('^(initial-enabled-packs=.*),' + escapeRegExp(T.modId) + '$', 'm'), `$1,${modId}`);
      t = t.replace(/^management-server-secret=.*$/m, 'management-server-secret=');
    }
    if (!cfg.mixins) {
      if (/(^|\/)fabric\.mod\.json$/.test(path)) t = t.replace(/,\s*"mixins":\s*\[[^\]]*\]/, '');
      if (/neoforge\.mods\.toml$/.test(path)) t = t.replace(/\[\[mixins\]\]\s*\n\s*config\s*=\s*"[^"]*"\s*\n/g, '');
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
    L.push(`java_version=${cfg.javaVersion}`);
    L.push('');
    if (cfg.modPublish) {
      L.push(`modrinth_id=${escapePropertiesValue(cfg.modrinthId)}`);
      L.push(`curseforge_id=${escapePropertiesValue(cfg.curseforgeId)}`);
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
    L.push(`neoform=${escapePropertiesValue(cfg.neoformVersion)}`);
    if (cfg.loaders.neoforge || cfg.datagen) L.push(`neoforge=${escapePropertiesValue(cfg.neoforgeVersion)}`);
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

  function genRootBuild(cfg) {
    const P = [];
    P.push('    id("java")');
    P.push('    id("idea")');
    P.push(`    id("net.morthen.gradle.multiloader") version "${cfg.multiloaderPluginVersion}" apply false`);
    P.push('');
    if (cfg.loaders.fabric) P.push(`    id("net.fabricmc.fabric-loom") version "${cfg.loomVersion}" apply false`);
    if (cfg.loaders.forge) P.push(`    id("net.minecraftforge.gradle") version "${cfg.forgeGradleVersion}" apply false`);
    P.push(`    id("net.neoforged.moddev") version "${cfg.moddevVersion}" apply false`);
    if (cfg.modPublish) {
      P.push('');
      P.push(`    id("me.modmuss50.mod-publish-plugin") version "${cfg.modPublishPluginVersion}" apply false`);
    }
    return `plugins {\n${P.join('\n')}\n}\n\nsubprojects {\n    pluginManager.apply("idea")\n    idea.module.isDownloadSources = true\n}\n`;
  }

  function multiloaderBlock(sections) {
    const body = sections.filter((s) => s && s.length).map((s) => s.join('\n')).join('\n\n');
    return `plugins {\n    id("net.morthen.gradle.multiloader")\n}\n\nmultiloader {\n${body}\n}\n`;
  }

  function featureLines(cfg, publish) {
    const L = [];
    if (cfg.testmod) L.push('    withTestMod()');
    if (cfg.gametest) L.push('    withGametest()');
    if (publish && cfg.modPublish) L.push(...publish);
    return L;
  }

  function genCommonBuild(cfg) {
    return multiloaderBlock([
      ['    neoFormVersion = providers.gradleProperty("neoform")'],
      featureLines(cfg, null),
    ]);
  }

  function genDatagenBuild() {
    return multiloaderBlock([
      ['    loader = "datagen"', '    neoForgeVersion = providers.gradleProperty("neoforge")'],
      ['    applyMetadataReplacements(listOf("pack.mcmeta", "META-INF/neoforge.mods.toml"))'],
    ]);
  }

  function genFabricBuild(cfg) {
    const publish = ['    withModPublish {', '        required.set(listOf(', '            "fabric-api"', '        ))'];
    if (cfg.modMenu) publish.push('        optional.set(listOf(', '            "modmenu"', '        ))');
    publish.push('    }');
    const patterns = ['"pack.mcmeta"'];
    if (cfg.mixins) patterns.push('"*.mixins.json"');
    patterns.push('"fabric.mod.json"');
    let out = multiloaderBlock([
      ['    loader = "fabric"'],
      ['    fabricApiVersion = providers.gradleProperty("fabric_api")', '    fabricLoaderVersion = providers.gradleProperty("fabric_loader")'],
      featureLines(cfg, publish),
      [`    applyMetadataReplacements(listOf(${patterns.join(', ')}), mapOf(`,
        '        "fabric_api" to fabricApiVersion.get(),',
        '        "fabric_loader" to fabricLoaderVersion.get(),',
        '        "sources_url" to providers.gradleProperty("sources_url").get(),',
        '        "issues_url" to providers.gradleProperty("issues_url").get()',
        '    ))'],
    ]);
    if (cfg.modMenu) out += `\ndependencies {\n    implementation("com.terraformersmc:modmenu:${cfg.modMenuVersion}")\n}\n`;
    return out;
  }

  function genForgeBuild(cfg) {
    const versionLines = ['    forgeVersion = providers.gradleProperty("forge")'];
    if (cfg.mixins) {
      versionLines.push('    forgeMixins = listOf(',
        '        "${ modId.get() }.mixins.json",',
        '        "${ modId.get() }.forge.mixins.json"',
        '    )');
    }
    return multiloaderBlock([
      ['    loader = "forge"'],
      versionLines,
      featureLines(cfg, ['    withModPublish()']),
      ['    applyMetadataReplacements(listOf("pack.mcmeta", "META-INF/mods.toml"), mapOf(',
        '        "forge_version" to forgeVersion.get(),',
        '        "issues_url" to providers.gradleProperty("issues_url")',
        '    ))'],
    ]);
  }

  function genNeoForgeBuild(cfg) {
    return multiloaderBlock([
      ['    loader = "neoforge"', '    neoForgeVersion = providers.gradleProperty("neoforge")'],
      featureLines(cfg, ['    withModPublish()']),
      ['    applyMetadataReplacements(listOf("pack.mcmeta", "META-INF/neoforge.mods.toml"), mapOf(',
        '        "neoforge_version" to neoForgeVersion.get(),',
        '        "sources_url" to providers.gradleProperty("sources_url").get(),',
        '        "issues_url" to providers.gradleProperty("issues_url").get()',
        '    ))'],
    ]);
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
    L.push(`- JDK ${cfg.javaVersion} (Gradle's toolchain support downloads one automatically if it is missing)`);
    L.push('- Git');
    L.push('');
    L.push('## Project layout');
    L.push('');
    L.push('| Module | Purpose |');
    L.push('| --- | --- |');
    L.push('| `common` | Loader-independent code and resources. Compiled into every loader jar. |');
    if (cfg.datagen) L.push('| `datagen` | Data generators (run on NeoForge). Output is written to `common/src/generated`. |');
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
    L.push('Game directories live in `common/runs/`.');
    L.push('');
    L.push('| Task | Description |');
    L.push('| --- | --- |');
    if (cfg.loaders.fabric) L.push('| `:fabric:runClient` / `:fabric:runServer` | Fabric client / server |');
    if (cfg.loaders.forge) L.push('| `:forge:runClient` / `:forge:runServer` | Forge client / server |');
    if (cfg.loaders.neoforge) L.push('| `:neoforge:runClient` / `:neoforge:runServer` | NeoForge client / server |');
    if (cfg.testmod) L.push('| `:<loader>:runTestmodClient` / `runTestmodServer` | Same, with the `testmod` source set loaded as a second mod |');
    if (cfg.gametest) {
      if (cfg.loaders.fabric) L.push('| `:fabric:runGameTests` | Run the game tests on Fabric |');
      if (cfg.loaders.forge) L.push('| `:forge:runGameTestServer` | Run the game tests on Forge (generates test instances via `:forge:runData` first) |');
      if (cfg.loaders.neoforge) L.push('| `:neoforge:runGametestServer` | Run the game tests on NeoForge |');
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
      L.push('A platform is skipped automatically when its id/token pair is missing. `CHANGELOG.md` is used as the release changelog.');
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
    const ctx = makeContext(cfg);
    const out = new Map();
    const put = (path, entry) => {
      if (entry === null || entry === undefined) return;
      if (out.has(path)) throw new Error(`Output path collision: ${path}`);
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

    // regenerated top-level files
    put('gradle.properties', { text: genGradleProperties(cfg) });
    put('settings.gradle.kts', { text: genSettings(cfg, td) });
    put('build.gradle.kts', { text: genRootBuild(cfg) });
    put('gradle/wrapper/gradle-wrapper.properties', { text: genWrapperProperties(cfg, td) });
    put('README.md', { text: genReadme(cfg, td) });
    put('CHANGELOG.md', { text: genChangelog(cfg) });
    const license = genLicense(cfg, global.LICENSE_DATA);
    if (license) put('LICENSE', { text: license });

    put('common/build.gradle.kts', { text: genCommonBuild(cfg) });
    if (cfg.datagen) put('datagen/build.gradle.kts', { text: genDatagenBuild(cfg) });
    if (cfg.loaders.fabric) put('fabric/build.gradle.kts', { text: genFabricBuild(cfg) });
    if (cfg.loaders.forge) put('forge/build.gradle.kts', { text: genForgeBuild(cfg) });
    if (cfg.loaders.neoforge) put('neoforge/build.gradle.kts', { text: genNeoForgeBuild(cfg) });

    // optional binary assets referenced by the loader metadata files
    if (cfg.icon) put(`common/src/main/resources/${cfg.modId}.png`, { bytes: cfg.icon });
    if (cfg.banner) put(`common/src/main/resources/${cfg.modId}_banner.png`, { bytes: cfg.banner });

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

  /** Datagen provider names as they appear in .cache headers (unquoted, so rewriteText() does not cover them). */
  function rewriteProviderName(name, ctx) {
    let n = replaceAll(name, `${T.modName} Recipe Provider`, `${ctx.modName} Recipe Provider`);
    n = n.replace(new RegExp(' mod id ' + escapeRegExp(T.modId) + '$'), ` mod id ${ctx.modId}`);
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
    T, LICENSES, JAVA_KEYWORDS,
    templateDefaults, uiDefaults, normalizeConfig, validate, generate, buildZip,
    suggestModId, suggestClassPrefix, suggestRootProjectName, suggestPackage, suggestIssuesUrl,
    enabledSubprojects, sha1Hex, entryBytes, escapePropertiesValue, parseProperties,
  };
})(typeof window !== 'undefined' ? window : globalThis);
