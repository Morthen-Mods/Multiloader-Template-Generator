# Multiloader Mod Project Generator

A static web tool that turns the [Morthen-Mods Multiloader-Template](https://github.com/Morthen-Mods/Multiloader-Template)
into a ready-to-build Minecraft mod project. Fill in the single-screen form, download a ZIP.

Everything runs in the browser. There is no backend, nothing is uploaded, and the page works from a plain
`file://` URL as well as from any static host (GitHub Pages, Netlify, an S3 bucket, …).

## What you can configure

| Group | Options |
| --- | --- |
| Mod | name, mod ID, author, version, description, license (MIT, Apache-2.0, MPL-2.0, LGPL-3.0, GPL-3.0, all-rights-reserved, none), environment (client and server, client only, server only, client or server), Maven group, Java base package, class prefix, project name |
| Loaders | any combination of Fabric, Forge and NeoForge |
| Features | common datagen, mixins, test mod, gametests, common run directory. Mod Menu comes with Fabric automatically whenever a build exists for the selected Minecraft version |
| Publishing | mod-publish-plugin setup with Modrinth / CurseForge project IDs and release type (release, beta, alpha), source and issue URLs |
| Assets | mod icon and banner PNGs (placed in `common/src/main/resources`), in the Mod card |
| Versions | Minecraft (every release from 1.20.1 on, which is what the [multiloader plugin](https://github.com/Morthen-Mods/multiloader-gradle-plugin) supports; it rejects snapshots, pre-releases and release candidates), NeoForm, and per loader its own versions, all as dropdowns filled from the official version lists and defaulting to the newest entry. The Java version is not a choice: the plugin derives it from the Minecraft version (17 below 1.20.5, 21 below 26, 25 from 26.1) |
| Build tooling | Gradle wrapper version, JVM args, daemon flag, and the versions of the multiloader plugin (0.2.0 and newer), ModDevGradle, Fabric Loom, ForgeGradle and the Foojay resolver (dropdowns fed from the respective release lists). mod-publish-plugin ships with the multiloader plugin and needs no version |

Derived fields (mod ID, base package, class prefix, project name, issue URL) follow the fields they are based on
until you edit them; the `↺` button switches a field back to automatic.

The form is laid out in three columns: the mod itself on the left, what it targets and contains in the middle
(Minecraft, the loaders each carrying their own versions, and the project contents), and the output on the right
(publishing and build tooling).

The current configuration is encoded in the URL fragment, so a link to the page restores it (binary assets
excluded; fields on *latest* are not pinned in the link and resolve to whatever is newest when it is opened). **Copy link** puts that URL on the clipboard.

## How the generation works

`scripts/bake.py` snapshots the upstream template into `js/templates/`, one file per template branch, plus a
small manifest. At runtime `js/generator.js` transforms the snapshot that matches the selected Minecraft
version:

* Java package directories and identifiers (`com.example.example_mod`) are moved to the configured base package.
* The example classes `ExampleModMod`, `ExampleModProvider` and `ExampleModTest` are renamed with the class prefix,
  `MOD_ID` / `MOD_NAME` constants and the `example_mod:` namespace in generated data are replaced.
* Resource files are renamed from `example_mod.*` (`<mod id>.mixins.json`, `<mod id>.classtweaker`, `data/<mod id>/…`), and the
  `META-INF/services` file for `IPlatformHelper` gets the new fully qualified name.
* `gradle.properties`, `settings.gradle.kts`, the root and per-module `build.gradle.kts`, the wrapper
  properties, `README.md`, `CHANGELOG.md` and `LICENSE` are generated from the configuration. The build scripts
  use the DSL of multiloader plugin 0.2.0: the root project applies the plugin and holds every shared setting in
  `multiloaderSettings { }`, each subproject only picks its `loader` (plus `modifierType` on Fabric and the
  `mixins` list on Forge). With the template's own values they reproduce the upstream files byte for byte (this is
  covered by a test).
* Disabled loaders and features are removed consistently: subproject folders, `settings.gradle.kts` includes,
  loader Gradle plugins in the root build script, `withTestmod()` / `withGametest()` / `withModPublish { }` and
  `commonRunDirectory`, the placeholder patterns and values of `applyMetadataReplacements`, mixin configs and
  their references in `fabric.mod.json` / `neoforge.mods.toml` / the Forge `mixins` list.
* The Minecraft version decides what the plugin needs: no `neoform` / `neoforge` on 1.20.1 (ModDevGradle Legacy
  compiles against MCP and NeoForge is not supported there), and Mod Menu as a remapped `modImplementation`
  dependency below 26, added in an `afterEvaluate` block because the plugin applies `fabric-loom-remap` in its own.
* The environment says where the mod has to be installed. It is mirrored into the loader metadata and, when
  publishing, into `withModPublish { side = ModSide.… }` (Modrinth environment, CurseForge client/server tags):

  | Environment | `side` | `fabric.mod.json` | Forge `mods.toml` |
  | --- | --- | --- | --- |
  | Client and server | `CLIENT_AND_SERVER` (plugin default, not written) | `"environment": "*"` | – |
  | Client only | `CLIENT_ONLY` | `"environment": "client"` | `clientSideOnly = true` |
  | Server only (also in singleplayer) | `SERVER_ONLY` | `"environment": "*"` | `displayTest = "IGNORE_SERVER_VERSION"` |
  | Client or server | `CLIENT_OR_SERVER` | `"environment": "*"` | `displayTest = "IGNORE_ALL_VERSION"` |

  Fabric's `"server"` means a dedicated server only, so a server-side mod that also works in singleplayer stays
  `"*"`. NeoForge has neither key; a client-only NeoForge mod restricts itself in code (`@Mod(dist = Dist.CLIENT)`).
  A release type other than release is written as `type = BETA` / `type = ALPHA` in `withModPublish`.
* An empty `modrinth_id` / `curseforge_id` is written commented out, because the plugin uploads to a platform as
  soon as its key exists. The client run passes the author as `--username` only when Minecraft accepts it as a
  player name.
* Minecraft's datagen `.cache` files are recomputed (SHA-1 of provider name and file contents) so the first
  `runData` does not see stale entries.
* `gradlew` is marked executable inside the ZIP regardless of how it is stored upstream.

All version defaults are read from the snapshot, so re-baking a newer template updates the defaults without
touching the generator.

## Version lists

The Minecraft, NeoForm, NeoForge, Forge, Fabric Loader and Fabric API fields, and the build
tooling versions under "Build tooling", are dropdowns.
Their contents are fetched in the browser when the page opens (cached in `localStorage` for an hour, the
**Refresh** button bypasses the cache):

| Data | Source |
| --- | --- |
| Minecraft releases from 1.20.1 on | Mojang's `version_manifest_v2.json` |
| NeoForm, NeoForge | `maven.neoforged.net` version API |
| Forge | `maven.minecraftforge.net` Maven metadata |
| Fabric API | `maven.fabricmc.net` Maven metadata |
| Fabric Loader | `meta.fabricmc.net` |
| Mod Menu | Modrinth API, per Minecraft version. Not a field: the newest build is used when one exists |
| Gradle | `services.gradle.org/versions/all` (final releases from 8.0) |
| Multiloader plugin | `maven.morthen.net` version API (releases from 0.2.0 on, the first with the DSL the generator writes) |
| ModDevGradle | `maven.neoforged.net` version API |
| Fabric Loom | `maven.fabricmc.net` Maven metadata (releases plus the `x.y-SNAPSHOT` lines) |
| ForgeGradle | `maven.minecraftforge.net` plugin-marker metadata |
| Foojay resolver | GitHub tags of `gradle/foojay-toolchains`, read through the jsDelivr API (the GitHub API allows only 60 anonymous requests per hour and IP) |

Every version field starts on the newest entry of its list (marked *latest*) and keeps following it until you pick
something else; the `↺` button returns a field to *latest*. Picking a Minecraft version puts every dependent field
back on the newest matching build; every dropdown also has a *Custom…* entry for typing a version by hand. Loaders
without a build for the chosen version (for example NeoForge on 1.20.1, or Forge on 1.21.2) are switched off and
greyed out, as is the datagen module when NeoForge is unavailable (except on 1.20.1, where it runs on ModDevGradle
Legacy); the previous selection returns when a supported version is chosen again. Fields the version does not use
(NeoForm on 1.20.1) are greyed out. Hand-typed versions the manifest does not know are never restricted. The
mapping rules live in `js/versions.js`:

| Minecraft | NeoForm | NeoForge | Forge | Fabric API |
| --- | --- | --- | --- | --- |
| 1.20.1 | – (MCP) | – | `1.20.1-47.x` | `0.92.x+1.20.1` |
| 1.21.1 | `1.21.1-20240808.144430` | `21.1.<build>` | `1.21.1-52.x` | `0.116.x+1.21.1` |
| 1.21 | `1.21-<timestamp>` | `21.0.<build>` | `1.21-51.x` | `0.102.x+1.21` |
| 26.1.2 | `26.1.2-<n>` | `26.1.2.<build>` | `26.1.2-64.x` | `0.155.x+26.1.2` |

`js/versions-data.js` is a bundled copy of those lists. It fills the dropdowns before the live fetch finishes
and is the fallback when a server cannot be reached. Regenerate it with:

```
scripts/bake-versions.py      # runs js/versions.js in headless Chrome and writes js/versions-data.js
```

The loader dropdowns (NeoForm, NeoForge, Forge, Fabric Loader, Fabric API) show the newest 15 entries,
the build tooling dropdowns the newest ten; older versions can still be typed in via *Custom…*. NeoForge beta
builds are hidden as soon as a release build exists for the selected Minecraft version.

## Daily refresh (GitHub Actions)

`.github/workflows/refresh.yml` runs daily at 00:00 UTC (01:00 CET / 02:00 CEST) and on manual dispatch, in
three jobs:

1. **verify** re-bakes the template snapshots of every upstream branch and the version catalog, then runs the
   generator suite (including the byte-for-byte comparison with every branch) and the UI check.
2. **build** runs `./gradlew build` (plus the testmod and gametest compile tasks) on the generated `build-<snapshot>`
   project of every template snapshot whose files changed, one job per snapshot. The generated projects depend
   only on the snapshots, not on the version catalog, so a day that only brings new loader versions builds
   nothing; a manual run builds every snapshot. Each job has JDK 17, 21 and 25, so the toolchain the multiloader
   plugin picks for the Minecraft version is already installed.
3. **publish** commits the regenerated `js/templates/` and `js/versions-data.js` to `main`, which GitHub Pages
   then publishes, but only if something besides the bake timestamps changed and every build passed.

A failed run leaves the site untouched and shows up as a red workflow run, which is the signal that the upstream
template changed in a way the generator does not understand yet.

## One template per Minecraft version

The upstream template keeps a branch per Minecraft version line, so a project for an older version is built
from the sources that actually worked back then. The 26.1 branch still writes `logoFile` into
`neoforge.mods.toml`, for instance, where 26.2 writes `iconFile` and `bannerFile`.

Which branch serves a version is read from that branch's own `gradle.properties`, never from the branch name.
A branch may therefore be named anything; only the `minecraft_version` it declares counts. A template serves the
version it declares and that version's patch releases. Selecting a version resolves like this:

```
26.2      -> the template declaring 26.2
26.2.1    -> a patch release without a branch of its own falls back to the one declaring 26.2
1.21.1    -> no template of this line: the nearest template stands in (the newest one not newer than
             1.21.1, otherwise the oldest one), and the form says so
```

A stand-in template only provides the example sources and resources; the build files are still generated for
the selected Minecraft version. Its sources usually need porting, so the form shows a note whenever no template
targets the selected version. To support an older line properly, add a branch such as `1.21.1` or `1.20.1` to the
template; the daily bake picks it up without any change here.

The build scripts are always written in the current plugin DSL. A branch whose own scripts still use the pre-0.2.0
DSL contributes its sources and resources unchanged; only its build scripts and `gradle.properties` are replaced.

The loaders a branch builds are the ones its `settings.gradle.kts` includes. The 1.21.2 branch, for example, keeps
a `forge/` folder but does not include it, because Forge skipped 1.21.2; its template defaults therefore leave
Forge out (in the form, Forge is unavailable on 1.21.2 anyway, as the version catalog has no build for it).

The footer names the branch and commit the current project comes from. `scripts/bake.py` bakes every branch
whose name looks like a version, plus the default branch as the fallback. The default snapshot ships in a
script tag; the others are fetched only when a version needs them, so a visit downloads one template, not all.

The naming of the example mod is derived per branch (mod id, display name, class prefix, package) and stored in
the snapshot. An upstream rename therefore needs no code change here, and older branches may use a completely
different naming than current ones.

## Running locally

Open `index.html` in a browser. No build step, no dependencies beyond the vendored `vendor/jszip.min.js`.

## Deploying

Copy the repository contents (everything except `scripts/`, `tests/` and `licenses/` is needed at runtime) to
any static host. For GitHub Pages: push the repository and enable Pages for the branch root.

## Updating the template snapshot

```
scripts/bake.py                                    # clones upstream, bakes every version branch
scripts/bake.py --branches main 26.2               # only these branches
scripts/bake.py --source ../Multiloader-Template   # a local clone (needs all branches)
```

Commit the regenerated `js/templates/` afterwards and run the tests. A rename of the example mod upstream needs
no code change: the bake derives the naming from each branch and fails loudly if a branch no longer has the
expected shape.

## Tests

`tests/run_tests.py` drives `tests/harness.html` in headless Chrome for every configuration in
`tests/configs/`, plus two checks per entry of `js/templates/manifest.js`, so a new template branch is covered
without a new configuration:

* `fidelity-<branch>`: the template defaults of that branch must reproduce it byte for byte (compared with an
  upstream checkout). For a branch still on the pre-0.2.0 plugin DSL the build scripts and `gradle.properties`
  are left out of that comparison; for a branch that keeps a project folder it does not include (`forge/` on
  1.21.2), that folder, the root build script and `gradle.properties` are.
* `build-<snapshot>`: the `full_custom` configuration on each template snapshot; these are the projects the
  workflow builds with Gradle.

Each run unpacks the resulting ZIP into `tests/out/<name>/` and checks it (no leaked upstream identifiers,
loader/feature toggles, the build scripts per Minecraft version, executable bit, valid JSON, cache hashes):

```
python3 tests/run_tests.py --template /path/to/Multiloader-Template
python3 tests/run_tests.py --only build-1.21.11                       # a single configuration or check
```

Requires Python 3.12+ and Chrome/Chromium (`--chrome PATH` if it is not on `PATH`). The extracted projects under
`tests/out/` can be built with their own `./gradlew build` as a final check; `--build-matrix FILE` lists the
`build-<snapshot>` projects with their Minecraft and Java version and Gradle tasks, as the workflow uses them.

## Project layout

```
index.html            the app
css/style.css
js/app.js             UI: form binding, version dropdowns, URL state, download
js/generator.js       pure transformation logic (also used by the tests)
js/versions.js        live version catalog (Mojang, NeoForged, Forge, Fabric, Modrinth, build tooling)
js/templates/         generated template snapshots, one per branch, plus manifest and license texts
js/versions-data.js   generated bundled version catalog
vendor/jszip.min.js   JSZip 3.10.1 (MIT)
licenses/             SPDX license texts baked into the snapshot
scripts/bake.py       refreshes js/templates/
scripts/bake-versions.py  refreshes js/versions-data.js
tests/                headless end-to-end tests
```
