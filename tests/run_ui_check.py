#!/usr/bin/env python3
"""
Drives the real page (index.html) in headless Chrome through tests/ui-driver.html and checks that
the version dropdowns react to a Minecraft version change (down to the obfuscated 1.21.x line and
legacy 1.20.1), that versions without a template of their own say so, and that the "Custom…" entry
works. Needs network access for the live version lists.

Usage: tests/run_ui_check.py [--chrome PATH]
"""
import argparse
import html
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PAGE = os.path.join(ROOT, "tests", "ui-driver.html")
CHROME_CANDIDATES = ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser", "chrome"]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--chrome")
    args = ap.parse_args()
    chrome = args.chrome or next((shutil.which(c) for c in CHROME_CANDIDATES if shutil.which(c)), None)
    if not chrome:
        sys.exit("no Chrome/Chromium found; pass --chrome PATH")
    with tempfile.TemporaryDirectory(prefix="modgen-chrome-") as profile:
        cmd = [chrome, "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
               "--allow-file-access-from-files", f"--user-data-dir={profile}", "--virtual-time-budget=120000",
               "--dump-dom", f"file://{PAGE}"]
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    dom = res.stdout
    m_status = re.search(r'<div id="status">(.*?)</div>', dom, re.S)
    m_out = re.search(r'<pre id="out">(.*?)</pre>', dom, re.S)
    if not m_status or not m_status.group(1).strip():
        sys.exit("driver page produced no status; chrome stderr:\n" + res.stderr[-1500:])
    status = json.loads(html.unescape(m_status.group(1)))
    results = json.loads(html.unescape(m_out.group(1))) if m_out and m_out.group(1).strip() else {}
    print("driver status:", json.dumps(status))
    print(json.dumps(results, indent=1))
    if results.get("referenceFellBack"):
        print(f"note: {results['initial'].get('mc')} has incomplete loader builds upstream; "
              f"newest-build checks re-ran against {results.get('referenceMc')} instead")
    failures = []
    if status.get("status") != "ok":
        failures.append(f"driver: {status}")
    a = results.get("after26_1_2", {})
    v121 = results.get("v1_21_1", {})
    v120 = results.get("v1_20_1", {})
    tools = results.get("tools", {})
    mc_options = results.get("mcOptions", [])
    root_build = results.get("rootBuild", "")
    checks = [
        (results.get("initial", {}).get("mc") == (mc_options or [None])[0], "initial Minecraft version is the newest release"),
        (all(results.get("referenceLoaderFields", {}).get(k) == results.get("referenceInitialFirst", {}).get(k) for k in ("neoform", "neoforge", "forge", "fabricApi")), f"loader fields start on the newest build for that release ({results.get('referenceMc')}{', fell back from ' + results['initial']['mc'] if results.get('referenceFellBack') else ''})"),
        (all(v in mc_options for v in ("26.1.2", "26.1", "1.21.1", "1.20.1")), "release list reaches back to 1.20.1"),
        (bool(mc_options) and mc_options[-1] == "1.20.1", "nothing older than 1.20.1 is listed"),
        (not any(re.search(r"-(rc|pre|snapshot)-|\d\dw\d\d", v) for v in mc_options), "no snapshots, pre-releases or release candidates (the plugin rejects them)"),
        (a.get("neoform", "").startswith("26.1.2-"), "NeoForm follows the Minecraft switch"),
        (a.get("neoforge", "").startswith("26.1.2."), "NeoForge follows the Minecraft switch"),
        (a.get("forge", "").startswith("64."), "Forge follows the Minecraft switch"),
        (a.get("fabricApi", "").endswith("+26.1.2"), "Fabric API follows the Minecraft switch"),
        (a.get("java") == "25", "Java 25 for 26.1.2"),
        (bool(a.get("modMenu")) and a.get("modMenu") != "__custom__", "Mod Menu resolved from Modrinth"),
        (results.get("configAfterSwitch") == "26.1.2", "the config follows the new Minecraft version"),
        (results.get("customInputVisible") is True, "Custom… reveals the text input"),
        (any(l == "neoform=26.2-99" for l in results.get("gradleProperties", [])), "custom value reaches gradle.properties"),
        (not any(l.startswith("java_version=") for l in results.get("gradleProperties", [])), "java_version is left to the plugin"),
        ("multiloaderSettings {" in root_build and "mod-publish-plugin" not in root_build, "root build uses the plugin 0.2.0 DSL"),
        (results.get("downloadEnabled") is True, "download stays enabled with a custom value"),
        (results.get("leftCustomMode") is True, "picking a list entry leaves custom mode"),
        (tools.get("gradleVersion", {}).get("value") == tools.get("gradleVersion", {}).get("first") and tools.get("gradleVersion", {}).get("count", 0) >= 5, "Gradle dropdown starts on the newest release"),
        (all(v.get("value") == v.get("first") for v in tools.values()), "every build tool starts on its newest version"),
        (tools.get("multiloaderPluginVersion", {}).get("count", 0) >= 1, "Multiloader plugin versions listed"),
        (all(re.fullmatch(r"\d+(\.\d+)+", v) and tuple(map(int, v.split("."))) >= (0, 2, 0) for v in results.get("pluginOptions", ["x"])), f"only plugin releases from 0.2.0 on are offered ({results.get('pluginOptions')})"),
        (tools.get("moddevVersion", {}).get("count", 0) >= 3, "ModDevGradle versions listed"),
        (tools.get("forgeGradleVersion", {}).get("count", 0) >= 3 and tools["forgeGradleVersion"]["first"].startswith("7."), "ForgeGradle lists concrete 7.x versions"),
        (results.get("resetToLatest") is True, "the reset button returns a pinned field to the newest version"),
        (results.get("side", {}).get("options") == ["CLIENT_AND_SERVER", "CLIENT_ONLY", "SERVER_ONLY", "CLIENT_OR_SERVER"]
         and results["side"].get("releaseOptions") == ["STABLE", "BETA", "ALPHA"], "environment and release type dropdowns are filled"),
        (results.get("side", {}).get("fabricEnvironment") == "client" and results["side"].get("forgeClientSideOnly") is True,
         "a client-only mod sets the Fabric environment and Forge clientSideOnly"),
        ("import net.morthen.gradle.multiloader.api.ModSide\n" in results.get("side", {}).get("rootBuild", "")
         and "        type = BETA\n        side = ModSide.CLIENT_ONLY\n" in results.get("side", {}).get("rootBuild", ""),
         "environment and release type reach withModPublish"),
        (results.get("side", {}).get("releaseTypeDisabled") is True and results["side"].get("fabricEnvironmentWithoutPublish") == "client",
         "without publishing the release type is inactive, the environment still applies"),
        (tools.get("foojayVersion", {}).get("count", 0) >= 1, "Foojay resolver versions listed"),
        (all(v.get("count", 0) <= 11 for v in tools.values()), "build tool dropdowns are capped at the newest 10 (+ current pick)"),
        (not results.get("duplicateOptions"), f"no duplicate entries in any dropdown ({results.get('duplicateOptions')})"),
        (all(0 < c <= 16 for c in results.get("referenceApiCounts", {}).values()) and results.get("referenceApiCounts"), f"loader dropdowns are capped at the newest 15 (+ current pick) for {results.get('referenceMc')}: {results.get('referenceApiCounts')}"),
        (results.get("referenceNeoforgeHasBeta") is False, f"NeoForge hides beta builds once a release build exists ({results.get('referenceMc')})"),
        (results.get("templateNoteInitial") == "", "no template note for the newest release"),
        (results.get("templateFor26_1_2", {}).get("minecraftVersion") == results.get("expectedTemplateFor26_1_2", {}).get("minecraftVersion", "?")
         and results["templateFor26_1_2"]["minecraftVersion"] in ("26.1", "26.1.2"),
         f"26.1.2 switches to the {results.get('expectedTemplateFor26_1_2', {}).get('branch')} template"),
        (results.get("templateBack", {}).get("minecraftVersion") == "26.2", "switching back returns to the 26.2 template"),
        (results.get("templateNoteBack") == "", "the template note disappears again"),
        (bool(results.get("templateFor26_1_2", {}).get("branch")) and results["templateFor26_1_2"]["branch"] in results.get("footer", ""), "the footer names the branch in use"),
        (results.get("after26_1_2", {}).get("neoforgeOptions", 99) <= 16, "NeoForge list for 26.1.2 is capped too"),
        # obfuscated line without a template of its own
        (v121.get("neoform", "").startswith("1.21.1-2024"), "NeoForm maps to the timestamped 1.21.1 build"),
        (v121.get("neoforge", "").startswith("21.1."), "NeoForge maps 1.21.1 to 21.1.x"),
        (v121.get("forge", "").startswith("52."), "Forge maps 1.21.1 to 52.x"),
        (v121.get("fabricApi", "").endswith("+1.21.1"), "Fabric API maps to +1.21.1"),
        (v121.get("java") == "21", "Java 21 for 1.21.1"),
        (v121.get("covered") is False and "1.21.1" in v121.get("note", ""), "1.21.1 has no template of its own and says so"),
        ('"modImplementation"("com.terraformersmc:modmenu:' in v121.get("fabricBuild", "") and 'afterEvaluate {' in v121.get("fabricBuild", ""), "Mod Menu is a remapped modImplementation dependency below 26"),
        (all(v121.get("chips", {}).get(k, {}).get("checked") for k in ("fabric", "forge", "neoforge", "datagen")), "every loader is available for 1.21.1"),
        # legacy 1.20.1
        (v120.get("chips", {}).get("neoforge", {}).get("disabled") is True and v120.get("loaders", {}).get("neoforge") is False, "NeoForge is unavailable on 1.20.1"),
        (v120.get("chips", {}).get("datagen", {}).get("disabled") is False and v120.get("datagen") is True, "datagen stays available on 1.20.1 (ModDevGradle Legacy)"),
        (v120.get("neoformInactive") is True and v120.get("neoforgeInactive") is True, "NeoForm and NeoForge fields are inactive on 1.20.1"),
        (not any(l.startswith(("neoform=", "neoforge=")) for l in v120.get("props", [])) and any(l.startswith("forge=47.") for l in v120.get("props", [])), f"gradle.properties for 1.20.1 has no NeoForm/NeoForge ({v120.get('props')})"),
        (v120.get("java") == "17", "Java 17 for 1.20.1"),
        (v120.get("downloadEnabled") is True and not v120.get("errors"), f"1.20.1 validates ({v120.get('errors')})"),
        (all(results.get("chipsAfterReturn", {}).get(k, {}).get("checked") and not results["chipsAfterReturn"][k]["disabled"] for k in ("fabric", "forge", "neoforge", "datagen")), "switching back to 26.2 restores the loader selection"),
    ]
    for ok, label in checks:
        print(("PASS " if ok else "FAIL ") + label)
        if not ok:
            failures.append(label)
    print(f"\n{len(checks) - len(failures)}/{len(checks)} checks passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
