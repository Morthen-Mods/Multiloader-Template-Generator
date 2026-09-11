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
        (results.get("initial", {}).get("mc") == "26.2", "initial Minecraft version is the template's"),
        ("26.1.2" in results.get("mcOptions", []) and "26.1" in results.get("mcOptions", []), "release list contains 26.1.x"),
        (a.get("neoform", "").startswith("26.1.2-"), "NeoForm follows the Minecraft switch"),
        (a.get("neoforge", "").startswith("26.1.2."), "NeoForge follows the Minecraft switch"),
        (a.get("forge", "").startswith("64."), "Forge follows the Minecraft switch"),
        (a.get("fabricApi", "").endswith("+26.1.2"), "Fabric API follows the Minecraft switch"),
        (a.get("java") == "25", "Java resolved from the manifest"),
        (bool(a.get("modMenu")) and a.get("modMenu") != "__custom__", "Mod Menu resolved from Modrinth"),
        ("MC 26.1.2" in results.get("summaryAfterSwitch", ""), "summary reflects the new Minecraft version"),
        (results.get("snapshotCount", 0) > len(results.get("mcOptions", [])), "snapshot toggle adds versions"),
        (not results.get("snapshot") or "alpha" in (results["snapshot"].get("neoforge") or "") or results["snapshot"].get("neoforge") == "", "snapshot maps to NeoForge alpha builds (or none)"),
        (not results.get("snapshot") or (results["snapshot"].get("neoform") or "").startswith(results["snapshot"]["mc"] + "-"), "snapshot maps to a NeoForm build"),
        (results.get("customInputVisible") is True, "Custom… reveals the text input"),
        (any(l == "neoform=26.2-99" for l in results.get("gradleProperties", [])), "custom value reaches gradle.properties"),
        (results.get("downloadEnabled") is True, "download stays enabled with a custom value"),
        (results.get("leftCustomMode") is True, "picking a list entry leaves custom mode"),
        (results.get("tools", {}).get("gradleVersion", {}).get("value") == "9.6.1" and results["tools"]["gradleVersion"]["count"] >= 5, "Gradle dropdown lists releases and keeps the template default"),
        (results.get("tools", {}).get("multiloaderPluginVersion", {}).get("count", 0) >= 3, "Multiloader plugin versions listed"),
        (results.get("tools", {}).get("moddevVersion", {}).get("count", 0) >= 3, "ModDevGradle versions listed"),
        ("1.17-SNAPSHOT" == results.get("tools", {}).get("loomVersion", {}).get("value"), "Loom keeps the template's snapshot line"),
        (results.get("tools", {}).get("forgeGradleVersion", {}).get("first") == "[7.0.30, 8)" and results["tools"]["forgeGradleVersion"]["count"] >= 3, "ForgeGradle offers the template range plus concrete versions"),
        (results.get("tools", {}).get("modPublishPluginVersion", {}).get("count", 0) >= 2, "mod-publish-plugin versions come from the bundled list"),
        (results.get("tools", {}).get("foojayVersion", {}).get("count", 0) >= 1, "Foojay resolver versions listed"),
        (all(v.get("count", 0) <= 11 for v in results.get("tools", {}).values()), "build tool dropdowns are capped at the newest 10 (+ template entry)"),
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
            (("Forge" in results.get("snapshotSummary", "")) == (snap_forge != ""), "summary lists only supported loaders"),
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
