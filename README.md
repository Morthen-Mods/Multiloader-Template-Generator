# Multiloader Mod Project Generator

A static web tool that turns the [Morthen-Mods Multiloader-Template](https://github.com/Morthen-Mods/Multiloader-Template)
into a ready-to-build Minecraft mod project. Fill in the single-screen form, download a ZIP.

Everything runs in the browser. There is no backend, nothing is uploaded, and the page works from a plain
`file://` URL as well as from any static host (GitHub Pages, Netlify, an S3 bucket, …).

## What you can configure

| Group | Options |
| --- | --- |
| Mod | name, mod ID, author, version, description, license (MIT, Apache-2.0, MPL-2.0, LGPL-3.0, GPL-3.0, all-rights-reserved, none), Maven group, Java base package, class prefix, project name |
| Loaders | any combination of Fabric, Forge and NeoForge |
| Features | common datagen, game tests, test mod, mixins, common run directory. Mod Menu comes with Fabric automatically whenever a build exists for the selected Minecraft version |
| Publishing | mod-publish-plugin setup with Modrinth / CurseForge project IDs, source and issue URLs |
| Assets | mod icon and banner PNGs (placed in `common/src/main/resources`), in the Mod card |
| Versions | Minecraft (26.1+, snapshots optional), NeoForm, and per loader its own versions, all as dropdowns filled from the official version lists and defaulting to the newest entry. The Java version is not a choice: it comes from Mojang's manifest for the selected Minecraft version |
| Build tooling | Gradle wrapper version, JVM args, daemon flag, and the versions of the multiloader plugin, ModDevGradle, Fabric Loom, ForgeGradle, mod-publish-plugin and the Foojay resolver (dropdowns fed from the respective release lists) |

Derived fields (mod ID, base package, class prefix, project name, issue URL) follow the fields they are based on
until you edit them; the `↺` button switches a field back to automatic.

The form is laid out in three columns: the mod itself on the left, what it targets in the middle (Minecraft, and
the loaders each carrying their own versions), and what goes into it plus how it is built on the right. The build
tooling card starts collapsed, because its versions follow the newest releases on their own.

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
  properties, `README.md`, `CHANGELOG.md` and `LICENSE` are generated from the configuration. With the template's
  own values they reproduce the upstream files byte for byte (this is covered by a test).
* Disabled loaders and features are removed consistently: subproject folders, `settings.gradle.kts` includes,
  loader Gradle plugins in the root build script, `withTestMod()` / `withGametest()` / `withModPublish()` calls,
  mixin configs and their references in `fabric.mod.json` / `neoforge.mods.toml` / `forgeMixins`.
* Minecraft's datagen `.cache` files are recomputed (SHA-1 of provider name and file contents) so the first
  `runData` does not see stale entries.
* `gradlew` is marked executable inside the ZIP regardless of how it is stored upstream.

All version defaults are read from the snapshot, so re-baking a newer template updates the defaults without
touching the generator.

## Version lists

The Minecraft, NeoForm, NeoForge, Forge, Fabric Loader, Fabric API and Mod Menu fields, and the build
tooling versions under "Build tooling", are dropdowns.
Their contents are fetched in the browser when the page opens (cached in `localStorage` for an hour, the
**Refresh** button bypasses the cache):

| Data | Source |
| --- | --- |
| Minecraft versions (26.1 and newer; snapshots optional) and the required Java version | Mojang's `version_manifest_v2.json` and the per-version manifests |
| NeoForm, NeoForge | `maven.neoforged.net` version API |
| Forge | `maven.minecraftforge.net` Maven metadata |
| Fabric API | `maven.fabricmc.net` Maven metadata |
| Fabric Loader | `meta.fabricmc.net` |
| Mod Menu | Modrinth API, per Minecraft version |
| Gradle | `services.gradle.org/versions/all` (final releases from 8.0) |
| Multiloader plugin | `maven.morthen.net` version API |
| ModDevGradle | `maven.neoforged.net` version API |
| Fabric Loom | `maven.fabricmc.net` Maven metadata (releases plus the `x.y-SNAPSHOT` lines) |
| ForgeGradle | `maven.minecraftforge.net` plugin-marker metadata |
| mod-publish-plugin | Gradle Plugin Portal; it sends no CORS headers, so this list only comes from the bundled catalog |
| Foojay resolver | GitHub tags of `gradle/foojay-toolchains` |

Every version field starts on the newest entry of its list (marked *latest*) and keeps following it until you pick
something else; the `↺` button returns a field to *latest*. Picking a Minecraft version puts every dependent field
back on the newest matching build; every dropdown also has a *Custom…* entry for typing a version by hand. Loaders without a build for the chosen version (for example
Forge and NeoForge on a fresh snapshot) are switched off and greyed out, as is the datagen module when NeoForge
is unavailable; the previous selection returns when a supported version is chosen again. Hand-typed versions the
manifest does not know are never restricted. The mapping rules (for example NeoForge `26.1.2.<build>` for
Minecraft `26.1.2`, `26.3.0.0-alpha.<n>+rc-1` for the `26.3-rc-1` snapshot, Fabric API `+26.3` for 26.3
snapshots) live in `js/versions.js`.

`js/versions-data.js` is a bundled copy of those lists. It fills the dropdowns before the live fetch finishes
and is the fallback when a server cannot be reached. Regenerate it with:

```
scripts/bake-versions.py      # runs js/versions.js in headless Chrome and writes js/versions-data.js
```

The bake runs Chrome with web security disabled so it can also read the Gradle Plugin Portal; the page itself
never does that. The loader dropdowns (NeoForm, NeoForge, Forge, Fabric Loader, Fabric API, Mod Menu) show the newest 15 entries,
the build tooling dropdowns the newest ten; older versions can still be typed in via *Custom…*. NeoForge beta
builds are hidden as soon as a release build exists for the selected Minecraft version.

## Weekly refresh (GitHub Actions)

`.github/workflows/refresh.yml` runs every Monday at 00:00 UTC (01:00 CET / 02:00 CEST) and on manual dispatch.
It re-bakes the template snapshot from the upstream repository and the version catalog, then runs the generator
suite (including a byte-for-byte comparison per branch), the UI check and a Gradle build of a generated project. Only if all of
that passes does it commit the regenerated `js/templates/` and `js/versions-data.js` to `main`, which
GitHub Pages then publishes. A failed run leaves the site untouched and shows up as a red workflow run, which is
the signal that the upstream template changed in a way the generator does not understand yet.

## One template per Minecraft version

The upstream template keeps a branch per Minecraft version line, so a project for an older version is built
from the sources that actually worked back then. The 26.1 branch still writes `logoFile` into
`neoforge.mods.toml`, for instance, where 26.2 writes `iconFile` and `bannerFile`.

Which branch serves a version is read from that branch's own `gradle.properties`, never from the branch name.
A branch may therefore be named anything; only the `minecraft_version` it declares counts. Selecting a version
resolves like this:

```
26.2      -> the template declaring 26.2
26.1.2    -> no exact match, falls back to the one declaring 26.1
26.3-rc-1 -> pre-releases are reduced to 26.3, then fall back to the default branch
```

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
`tests/configs/`, unpacks the resulting ZIP into `tests/out/<name>/` and checks it (no leaked upstream
identifiers, loader/feature toggles, executable bit, valid JSON, cache hashes, a byte-for-byte comparison with an
upstream checkout for the default configuration):

```
python3 tests/run_tests.py --template /path/to/Multiloader-Template
```

Requires Python 3 and Chrome/Chromium (`--chrome PATH` if it is not on `PATH`). The extracted projects under
`tests/out/` can be built with their own `./gradlew build` as a final check.

## Project layout

```
index.html            the app
css/style.css
js/app.js             UI: form binding, version dropdowns, URL state, download
js/generator.js       pure transformation logic (also used by the tests)
js/versions.js        live version catalog (Mojang, NeoForged, Forge, Fabric, Modrinth)
js/templates/         generated template snapshots, one per branch, plus manifest and license texts
js/versions-data.js   generated bundled version catalog
vendor/jszip.min.js   JSZip 3.10.1 (MIT)
licenses/             SPDX license texts baked into the snapshot
scripts/bake.py       refreshes js/templates/
scripts/bake-versions.py  refreshes js/versions-data.js
tests/                headless end-to-end tests
```
