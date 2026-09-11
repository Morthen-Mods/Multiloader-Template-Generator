#!/usr/bin/env python3
"""
Drives the real page (index.html) in headless Chrome through tests/ui-driver.html and checks that
the version dropdowns react to a Minecraft version change, that snapshots map to alpha builds,
and that the "Custom…" entry works. Needs network access for the live version lists.

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
    failures = []
    if status.get("status") != "ok":
        failures.append(f"driver: {status}")
    a = results.get("after26_1_2", {})
    checks = [
        (results.get("initial", {}).get("mc") == results.get("mcOptions", [None])[0], "initial Minecraft version is the newest release"),
        (all(results.get("initial", {}).get(k) == results.get("initialFirst", {}).get(k) for k in ("neoform", "neoforge", "forge", "fabricApi")), "loader fields start on the newest build for that release"),
        ("26.1.2" in results.get("mcOptions", []) and "26.1" in results.get("mcOptions", []), "release list contains 26.1.x"),
        (a.get("neoform", "").startswith("26.1.2-"), "NeoForm follows the Minecraft switch"),
        (a.get("neoforge", "").startswith("26.1.2."), "NeoForge follows the Minecraft switch"),
        (a.get("forge", "").startswith("64."), "Forge follows the Minecraft switch"),
        (a.get("fabricApi", "").endswith("+26.1.2"), "Fabric API follows the Minecraft switch"),
        (a.get("java") == "25", "Java resolved from the manifest"),
        (bool(a.get("modMenu")) and a.get("modMenu") != "__custom__", "Mod Menu resolved from Modrinth"),
        (results.get("configAfterSwitch") == "26.1.2", "the config follows the new Minecraft version"),
        (results.get("snapshotCount", 0) > len(results.get("mcOptions", [])), "snapshot toggle adds versions"),
        (not results.get("snapshot") or "alpha" in (results["snapshot"].get("neoforge") or "") or results["snapshot"].get("neoforge") == "", "snapshot maps to NeoForge alpha builds (or none)"),
        (not results.get("snapshot") or (results["snapshot"].get("neoform") or "").startswith(results["snapshot"]["mc"] + "-") or results["snapshot"].get("neoform") == "", "snapshot maps to a NeoForm build, or to none at all"),
        (results.get("customInputVisible") is True, "Custom… reveals the text input"),
        (any(l == "neoform=26.2-99" for l in results.get("gradleProperties", [])), "custom value reaches gradle.properties"),
        (results.get("downloadEnabled") is True, "download stays enabled with a custom value"),
        (results.get("leftCustomMode") is True, "picking a list entry leaves custom mode"),
        (results.get("tools", {}).get("gradleVersion", {}).get("value") == results.get("tools", {}).get("gradleVersion", {}).get("first") and results["tools"]["gradleVersion"]["count"] >= 5, "Gradle dropdown starts on the newest release"),
        (all(v.get("value") == v.get("first") for v in results.get("tools", {}).values()), "every build tool starts on its newest version"),
        (results.get("tools", {}).get("multiloaderPluginVersion", {}).get("count", 0) >= 3, "Multiloader plugin versions listed"),
        (results.get("tools", {}).get("moddevVersion", {}).get("count", 0) >= 3, "ModDevGradle versions listed"),
        (results.get("tools", {}).get("forgeGradleVersion", {}).get("count", 0) >= 3 and results["tools"]["forgeGradleVersion"]["first"].startswith("7."), "ForgeGradle lists concrete 7.x versions"),
        (results.get("resetToLatest") is True, "the reset button returns a pinned field to the newest version"),
        (results.get("tools", {}).get("modPublishPluginVersion", {}).get("count", 0) >= 2, "mod-publish-plugin versions come from the bundled list"),
        (results.get("tools", {}).get("foojayVersion", {}).get("count", 0) >= 1, "Foojay resolver versions listed"),
        (all(v.get("count", 0) <= 11 for v in results.get("tools", {}).values()), "build tool dropdowns are capped at the newest 10 (+ current pick)"),
        (not results.get("duplicateOptions"), f"no duplicate entries in any dropdown ({results.get('duplicateOptions')})"),
        (all(0 < c <= 16 for c in results.get("apiCounts", {}).values()) and results.get("apiCounts"), f"loader dropdowns are capped at the newest 15 (+ current pick): {results.get('apiCounts')}"),
        (results.get("neoforgeHasBeta") is False, "NeoForge hides beta builds once a release build exists (26.2)"),
        (results.get("templateInitial", {}).get("minecraftVersion") == "26.2", "26.2 uses the 26.2 template"),
        (results.get("templateFor26_1_2", {}).get("minecraftVersion") == "26.1", "26.1.2 falls back to the 26.1 template"),
        (results.get("templateBack", {}).get("minecraftVersion") == "26.2", "switching back returns to the 26.2 template"),
        (bool(results.get("templateFor26_1_2", {}).get("branch")) and results["templateFor26_1_2"]["branch"] in results.get("footer", ""), "the footer names the branch in use"),
        (not results.get("templateForSnapshot") or results["templateForSnapshot"].get("branch") == results.get("defaultBranch", results["templateForSnapshot"].get("branch")), "a Minecraft snapshot uses a template"),
        (results.get("after26_1_2", {}).get("neoforgeOptions", 99) <= 16, "NeoForge list for 26.1.2 is capped too"),
    ]
    sc = results.get("snapshotChips")
    if sc:
        snap_forge = results["snapshot"].get("forge") or ""
        snap_neo = results["snapshot"].get("neoforge") or ""
        checks += [
            (sc["forge"]["disabled"] == (snap_forge == "") and sc["forge"]["checked"] == (snap_forge != ""), "Forge chip disabled exactly when the snapshot has no Forge build"),
            (sc["neoforge"]["disabled"] == (snap_neo == "") and sc["neoforge"]["checked"] == (snap_neo != ""), "NeoForge chip disabled exactly when the snapshot has no NeoForge build"),
            (sc["datagen"]["disabled"] == (snap_neo == "") and sc["datagen"]["checked"] == (snap_neo != ""), "datagen follows NeoForge availability"),
            (sc["fabric"]["checked"] and not sc["fabric"]["disabled"], "Fabric stays selectable on the snapshot"),
            (results.get("snapshotLoaders", {}).get("forge", False) == (snap_forge != ""), "only supported loaders stay enabled"),
            (all(results["chipsAfterReturn"][k]["checked"] and not results["chipsAfterReturn"][k]["disabled"] for k in ("fabric", "forge", "neoforge", "datagen")), "switching back to 26.2 restores the loader selection"),
        ]
    for ok, label in checks:
        print(("PASS " if ok else "FAIL ") + label)
        if not ok:
            failures.append(label)
    print(f"\n{len(checks) - len(failures)}/{len(checks)} checks passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
