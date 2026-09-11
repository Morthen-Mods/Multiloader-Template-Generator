#!/usr/bin/env python3
"""
Bake the bundled version catalog (js/versions-data.js).

The web app fetches Minecraft / NeoForm / NeoForge / Forge / Fabric and build-tool versions live in the
browser; the bundled catalog is the fallback when a request fails (offline, blocked CDN, ...)
and provides the initial dropdown contents. It is produced with the very same JavaScript
(js/versions.js) by running scripts/versions-dump.html in headless Chrome.

Usage: scripts/bake-versions.py [--chrome PATH] [--wait-ms 45000]
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
PAGE = os.path.join(ROOT, "scripts", "versions-dump.html")
OUTPUT = os.path.join(ROOT, "js", "versions-data.js")
CHROME_CANDIDATES = ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser", "chrome"]


def find_chrome(explicit):
    if explicit:
        return explicit
    for c in CHROME_CANDIDATES:
        p = shutil.which(c)
        if p:
            return p
    sys.exit("no Chrome/Chromium found; pass --chrome PATH")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--chrome")
    ap.add_argument("--wait-ms", type=int, default=45000, help="virtual-time budget for the page's fetches (default %(default)s)")
    ap.add_argument("--output", default=OUTPUT)
    args = ap.parse_args()
    chrome = find_chrome(args.chrome)

    with tempfile.TemporaryDirectory(prefix="modgen-chrome-") as profile:
        # --disable-web-security: the Gradle Plugin Portal sends no CORS headers, so the bake (and only the
        # bake) fetches it without the browser's cross-origin checks; the app itself uses the bundled result.
        cmd = [chrome, "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
               "--disable-web-security", f"--user-data-dir={profile}", f"--virtual-time-budget={args.wait_ms}",
               "--dump-dom", f"file://{PAGE}"]
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=args.wait_ms / 1000 + 120)
    dom = res.stdout
    m_status = re.search(r'<div id="status">(.*?)</div>', dom, re.S)
    m_out = re.search(r'<pre id="out">(.*?)</pre>', dom, re.S)
    if not m_status or not m_status.group(1).strip():
        sys.exit(f"the dump page did not finish within {args.wait_ms} ms (try --wait-ms 90000). chrome stderr:\n{res.stderr[-1500:]}")
    status = json.loads(html.unescape(m_status.group(1)))
    if status.get("status") != "ok":
        sys.exit(f"catalog fetch failed: {status}")
    data = json.loads(html.unescape(m_out.group(1)))

    failed = [k for k, s in data["sources"].items() if s.get("origin") != "live"]
    if failed:
        sys.exit(f"sources failed: { {k: data['sources'][k] for k in failed} }")
    for p in status.get("problems", []):
        print("warning:", p)

    # summary table + sanity checks (the mapping itself lives in js/versions.js)
    releases = [v["id"] for v in data["minecraft"] if v["type"] == "release"]
    if not releases:
        sys.exit("no Minecraft releases >= 26 found")
    summary = status.get("summary", {})
    cols = ["java", "neoform", "neoforge", "forge", "fabricLoader", "fabricApi", "modMenu"]
    print(f"{'Minecraft':<10}" + "".join(f"{c:<18}" for c in cols))
    missing = []
    for mc in releases:
        row = summary.get(mc, {})
        print(f"{mc:<10}" + "".join(f"{str(row.get(c) or '-'):<18}" for c in cols))
        for c in ("neoform", "neoforge", "fabricApi"):
            if not row.get(c):
                missing.append(f"{mc}: no {c} version")
    print(f"lists: minecraft={len(data['minecraft'])} neoform={len(data['neoform'])} neoforge={len(data['neoforge'])} "
          f"forge={len(data['forge'])} fabricApi={len(data['fabricApi'])} fabricLoader={len(data['fabricLoader'])}")
    for m in missing:
        print("warning:", m)
    tools = status.get("tools", {})
    print("build tooling: " + ", ".join(f"{k}={v.get('latest')} ({v.get('count')})" for k, v in tools.items()))
    for k, v in tools.items():
        if not v.get("count"):
            sys.exit(f"no versions for build tool {k}")

    os.makedirs(os.path.dirname(args.output), exist_ok=True)
    with open(args.output, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("// GENERATED FILE - do not edit by hand. Regenerate with scripts/bake-versions.py\n")
        fh.write(f"// Bundled version catalog fetched {data['fetchedAt']}\n")
        fh.write("window.VERSION_DATA = ")
        json.dump(data, fh, ensure_ascii=False, separators=(",", ":"))
        fh.write(";\n")
    print(f"wrote {os.path.relpath(args.output, ROOT)} ({os.path.getsize(args.output) // 1024} KiB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
