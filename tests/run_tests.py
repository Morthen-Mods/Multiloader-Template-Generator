#!/usr/bin/env python3
"""
End-to-end tests for the generator.

Runs tests/harness.html in headless Chrome for every tests/configs/*.json, decodes the
produced ZIP, extracts it to tests/out/<name>/ and checks the result:

  * no upstream identifiers ("morthen", "template") leak into the output
  * loader / feature toggles add and remove exactly the expected files
  * gradlew is executable inside the ZIP
  * datagen .cache files are consistent with the generated data files
  * the "fidelity" config (pure template defaults) reproduces the upstream template

Usage: tests/run_tests.py [--chrome PATH] [--template PATH_TO_UPSTREAM_CHECKOUT] [--only NAME]
Exit code is non-zero when any check fails.
"""
import argparse
import base64
import hashlib
import io
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HARNESS = os.path.join(ROOT, "tests", "harness.html")
CONFIG_DIR = os.path.join(ROOT, "tests", "configs")
OUT_DIR = os.path.join(ROOT, "tests", "out")

CHROME_CANDIDATES = ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser", "chrome"]

# identifiers of the upstream example mod that must not survive the transformation
LEAK_RE = re.compile(r"morthen|example_mod|ExampleMod|com\.example|Example Mod")
# substrings that legitimately contain upstream names
ALLOWED_UPSTREAM = [
    "net.morthen.gradle.multiloader",   # plugin id
    "maven.morthen.net",                # plugin repository
    "github.com/Morthen-Mods/",         # README links back to the template + plugin
]
TEXT_EXT = {".java", ".kts", ".json", ".toml", ".mcmeta", ".cfg", ".classtweaker", ".txt", ".properties", ".md", "", ".bat", ".gitignore", ".gitattributes"}


def find_chrome(explicit):
    if explicit:
        return explicit
    for c in CHROME_CANDIDATES:
        p = shutil.which(c)
        if p:
            return p
    sys.exit("no Chrome/Chromium found; pass --chrome PATH")


def run_harness(chrome, spec):
    payload = json.dumps(spec).encode("utf-8")
    b64 = base64.urlsafe_b64encode(payload).decode("ascii").rstrip("=")
    url = f"file://{HARNESS}?config={b64}"
    with tempfile.TemporaryDirectory(prefix="modgen-chrome-") as profile:
        cmd = [chrome, "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
               f"--user-data-dir={profile}", "--virtual-time-budget=60000", "--dump-dom", url]
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
    dom = res.stdout
    m_status = re.search(r'<div id="status">(.*?)</div>', dom, re.S)
    m_out = re.search(r'<pre id="out">(.*?)</pre>', dom, re.S)
    if not m_status or not m_status.group(1).strip():
        raise RuntimeError(f"harness produced no status. chrome stderr:\n{res.stderr[-2000:]}\nDOM head:\n{dom[:500]}")
    status = json.loads(html_unescape(m_status.group(1)))
    zip_b64 = (m_out.group(1) if m_out else "").strip()
    return status, zip_b64


def html_unescape(s):
    import html
    return html.unescape(s)


def is_text_path(path):
    base = os.path.basename(path)
    if base in ("gradlew", ".gitignore", ".gitattributes", "LICENSE"):
        return True
    if "/.cache/" in path:
        return True
    return os.path.splitext(base)[1].lower() in TEXT_EXT


class Result:
    def __init__(self, name):
        self.name = name
        self.failures = []
        self.notes = []

    def check(self, cond, message):
        if not cond:
            self.failures.append(message)
        return cond

    def ok(self):
        return not self.failures


def extract_zip(zip_bytes, dest):
    if os.path.isdir(dest):
        shutil.rmtree(dest)
    os.makedirs(dest)
    entries = {}
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        for info in zf.infolist():
            if info.is_dir():
                continue
            data = zf.read(info)
            mode = (info.external_attr >> 16) & 0o777
            entries[info.filename] = {"mode": mode, "data": data}
            target = os.path.join(dest, info.filename)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(target, "wb") as fh:
                fh.write(data)
            if mode:
                os.chmod(target, mode)
    return entries


def check_flat(entries):
    """The project sits at the ZIP root; nothing may wrap it in a folder."""
    if "gradle.properties" not in entries:
        raise AssertionError(f"gradle.properties is not at the ZIP root; top entries: {sorted(entries)[:5]}")
    return entries


def check_common(r, files, cfg, leak_check=True):
    modid = cfg["modId"]
    pkg_path = cfg["basePackage"].replace(".", "/")
    loaders = cfg["loaders"]

    # 1. no upstream identifiers leak
    for path, e in files.items():
        if not leak_check or not is_text_path(path):
            continue
        text = e["data"].decode("utf-8", errors="replace")
        pattern = re.compile(r"morthen", re.I) if path == "LICENSE" else LEAK_RE
        for i, line in enumerate(text.splitlines(), 1):
            if pattern.search(line) and not any(a in line for a in ALLOWED_UPSTREAM):
                r.failures.append(f"upstream identifier leaked: {path}:{i}: {line.strip()[:120]}")
        r.check("com/example/example_mod" not in path, f"upstream package dir in path: {path}")

    # 2. executable bit
    r.check("gradlew" in files, "gradlew missing")
    if "gradlew" in files:
        r.check(files["gradlew"]["mode"] & 0o111 == 0o111, f"gradlew not executable (mode {files['gradlew']['mode']:o})")
    if "gradlew.bat" in files:
        r.check(files["gradlew.bat"]["mode"] == 0o644, f"gradlew.bat mode {files['gradlew.bat']['mode']:o}")
    r.check("gradle/wrapper/gradle-wrapper.jar" in files, "gradle-wrapper.jar missing")
    if "gradle/wrapper/gradle-wrapper.jar" in files:
        r.check(files["gradle/wrapper/gradle-wrapper.jar"]["data"][:2] == b"PK", "gradle-wrapper.jar is not a zip")
    if "gradle/wrapper/gradle-wrapper.properties" in files:
        wp = files["gradle/wrapper/gradle-wrapper.properties"]["data"].decode()
        r.check(f"gradle-{cfg['gradleVersion']}-" in wp, f"wrapper does not reference gradle {cfg['gradleVersion']}: {wp}")

    # 3. structure
    r.check("common/build.gradle.kts" in files, "common/build.gradle.kts missing")
    r.check(f"common/src/main/java/{pkg_path}/CommonConstants.java" in files, "CommonConstants.java not in configured package")
    r.check(f"common/src/main/resources/{modid}.classtweaker" in files, "classtweaker not renamed")
    settings = files["settings.gradle.kts"]["data"].decode()
    r.check(f'rootProject.name = "{cfg["rootProjectName"]}"' in settings, "rootProject.name wrong")
    root_build = files["build.gradle.kts"]["data"].decode()
    props = files["gradle.properties"]["data"].decode()
    r.check(f"mod_id={modid}\n" in props, "mod_id missing in gradle.properties")
    r.check(f"version={cfg['version']}\n" in props, "version missing in gradle.properties")

    for loader in ("fabric", "forge", "neoforge"):
        present = any(p.startswith(loader + "/") for p in files)
        r.check(present == loaders[loader], f"loader {loader}: present={present} expected={loaders[loader]}")
        r.check((f'"{loader}"' in settings) == loaders[loader], f"settings include for {loader} wrong")
        if loaders[loader]:
            r.check(f"{loader}/src/main/java/{pkg_path}/{cfg['classPrefix']}Mod.java" in files, f"{loader} entry class missing/misnamed")
            svc = f"{loader}/src/main/resources/META-INF/services/{cfg['basePackage']}.service.platform.IPlatformHelper"
            r.check(svc in files, f"service file missing: {svc}")
    r.check(('fabric-loom' in root_build) == loaders["fabric"], "loom plugin presence wrong in root build")
    r.check(('net.minecraftforge.gradle' in root_build) == loaders["forge"], "forgegradle plugin presence wrong in root build")
    r.check('net.neoforged.moddev' in root_build, "moddev plugin must always be present (common uses it)")
    r.check(('mod-publish-plugin' in root_build) == cfg["modPublish"], "mod-publish-plugin presence wrong in root build")
    r.check(("modrinth_id=" in props) == cfg["modPublish"], "modrinth_id presence wrong in gradle.properties")

    datagen_present = any(p.startswith("datagen/") for p in files)
    r.check(datagen_present == cfg["datagen"], f"datagen present={datagen_present} expected={cfg['datagen']}")
    gen_present = any(p.startswith("common/src/generated/") for p in files)
    r.check(gen_present == cfg["datagen"], f"common/src/generated present={gen_present} expected={cfg['datagen']}")
    if cfg["datagen"]:
        r.check(f"common/src/generated/data/{modid}/recipe/diamond.json" in files, "generated recipe not renamed to mod id")
        r.check(('"datagen"' in settings), "datagen missing from settings include")
        r.check("neoforge=" in props, "neoforge version required for datagen")

    gt_present = any("/src/gametest/" in p for p in files)
    r.check(gt_present == cfg["gametest"], f"gametest present={gt_present} expected={cfg['gametest']}")
    tm_present = any("/src/testmod/" in p for p in files)
    r.check(tm_present == cfg["testmod"], f"testmod present={tm_present} expected={cfg['testmod']}")
    for sub in ("common", "fabric", "forge", "neoforge"):
        p = f"{sub}/build.gradle.kts"
        if p in files:
            b = files[p]["data"].decode()
            r.check(("withGametest()" in b) == cfg["gametest"], f"{p}: withGametest presence wrong")
            r.check(("withTestMod()" in b) == cfg["testmod"], f"{p}: withTestMod presence wrong")
            if sub != "common":
                r.check(("withModPublish" in b) == cfg["modPublish"], f"{p}: withModPublish presence wrong")

    mixin_files = [p for p in files if p.endswith(".mixins.json")]
    r.check(bool(mixin_files) == cfg["mixins"], f"mixin files present={bool(mixin_files)} expected={cfg['mixins']}")
    if cfg["mixins"]:
        for p in mixin_files:
            r.check(os.path.basename(p).startswith(modid + "."), f"mixin config not renamed: {p}")
            data = json.loads(files[p]["data"].decode())
            r.check(data["package"] == cfg["basePackage"] + ".mixin", f"mixin package wrong in {p}")
    if loaders["fabric"]:
        fmj = json.loads(files["fabric/src/main/resources/fabric.mod.json"]["data"].decode())
        r.check(("mixins" in fmj) == cfg["mixins"], "fabric.mod.json mixins presence wrong")
        r.check(fmj["entrypoints"]["main"] == [f"{cfg['basePackage']}.{cfg['classPrefix']}Mod"], "fabric entrypoint wrong")
        fb = files["fabric/build.gradle.kts"]["data"].decode()
        r.check(("modmenu" in fb) == cfg["modMenu"], "modmenu presence wrong in fabric build")
        r.check(('"*.mixins.json"' in fb) == cfg["mixins"], "fabric metadata pattern for mixins wrong")
    if loaders["neoforge"]:
        toml = files["neoforge/src/main/resources/META-INF/neoforge.mods.toml"]["data"].decode()
        r.check(("[[mixins]]" in toml) == cfg["mixins"], "neoforge.mods.toml mixins presence wrong")
    if loaders["forge"]:
        fb = files["forge/build.gradle.kts"]["data"].decode()
        r.check(("forgeMixins" in fb) == cfg["mixins"], "forgeMixins presence wrong in forge build")

    # every .json must still parse (regex edits could break them)
    for p, e in files.items():
        if p.endswith(".json") or p.endswith(".mcmeta"):
            try:
                json.loads(e["data"].decode())
            except Exception as ex:
                r.failures.append(f"invalid JSON after transformation: {p}: {ex}")

    # 4. datagen caches
    for p, e in files.items():
        if "/.cache/" not in p:
            continue
        base = p.split("/.cache/")[0]
        lines = e["data"].decode().splitlines()
        header = lines[0]
        r.check(header.startswith("// " + cfg["minecraftVersion"] + "\t"), f"cache header wrong: {p}: {header}")
        provider = header.split("\t")[-1]
        r.check(os.path.basename(p) == hashlib.sha1(provider.encode()).hexdigest(), f"cache file name != sha1(provider) for {p}")
        for line in lines[1:]:
            h, rel = line.split(" ", 1)
            target = f"{base}/{rel}"
            r.check(target in files, f"cache references missing file {target}")
            if target in files:
                r.check(hashlib.sha1(files[target]["data"]).hexdigest() == h, f"cache hash mismatch for {target}")

    # 5. assets
    r.check((f"common/src/main/resources/{modid}.png" in files) == bool(cfg.get("icon")), "icon presence wrong")
    r.check((f"common/src/main/resources/{modid}_banner.png" in files) == bool(cfg.get("banner")), "banner presence wrong")

    # 6. license
    lic = cfg["modLicense"]
    r.check(("LICENSE" in files) == (lic != "NONE"), "LICENSE presence wrong")
    if lic == "MIT":
        r.check(b"MIT License" in files["LICENSE"]["data"], "MIT text missing")
    elif lic == "Apache-2.0":
        r.check(b"Apache License" in files["LICENSE"]["data"], "Apache text missing")
    elif lic == "LGPL-3.0-only":
        r.check(b"GNU LESSER GENERAL PUBLIC LICENSE" in files["LICENSE"]["data"], "LGPL text missing")

    # 7. run defaults
    r.check(("common/runs/client/options.txt" in files) == cfg["includeRunDefaults"], "run defaults presence wrong")
    if "common/runs/server/server.properties" in files:
        sp = files["common/runs/server/server.properties"]["data"].decode()
        r.check(re.search(r"^initial-enabled-packs=.*," + re.escape(modid) + r"$", sp, re.M) is not None, "server.properties initial-enabled-packs not renamed")
        r.check("management-server-secret=\n" in sp, "management-server-secret not blanked")


def check_fidelity(r, files, cfg, template_dir):
    """With template defaults the output must equal the upstream checkout (modulo README/.idea/cache timestamps)."""
    if not template_dir:
        r.notes.append("fidelity: skipped (no --template checkout given)")
        return
    upstream = {}
    for dirpath, dirnames, filenames in os.walk(template_dir):
        dirnames[:] = [d for d in dirnames if d not in (".git", ".idea", ".gradle", "build")]
        for fn in filenames:
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, template_dir).replace(os.sep, "/")
            with open(full, "rb") as fh:
                data = fh.read()
            if rel == "common/runs/server/server.properties":
                # the generator blanks the upstream dev-server secret on purpose
                data = re.sub(rb"(?m)^management-server-secret=.*$", b"management-server-secret=", data)
            if rel == "gradle.properties":
                # the generator always enables the Gradle daemon; upstream turns it off
                data = re.sub(rb"(?m)^org\.gradle\.daemon=.*$", b"org.gradle.daemon=true", data)
            upstream[rel] = data
    ignore = {"README.md"}

    def norm(path, data):
        if "/.cache/" in path:
            lines = data.decode().splitlines()
            parts = lines[0].split("\t")
            if len(parts) >= 3:
                parts[0] = "// X"
                parts[1] = "TIME"
            lines[0] = "\t".join(parts)
            return "\n".join(lines).rstrip("\n").encode()
        return data.rstrip(b"\r\n")  # generated files always end with a newline, upstream is inconsistent

    missing = sorted(p for p in upstream if p not in files and p not in ignore)
    extra = sorted(p for p in files if p not in upstream and p not in ignore)
    r.check(not missing, f"fidelity: files missing vs upstream: {missing}")
    r.check(not extra, f"fidelity: unexpected extra files: {extra}")
    for p in sorted(set(upstream) & set(files)):
        if p in ignore:
            continue
        a, b = norm(p, upstream[p]), norm(p, files[p]["data"])
        if a != b:
            import difflib
            diff = "".join(difflib.unified_diff(a.decode(errors="replace").splitlines(True), b.decode(errors="replace").splitlines(True), "upstream/" + p, "generated/" + p))
            r.failures.append(f"fidelity: content differs: {p}\n{diff[:1500]}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--chrome")
    ap.add_argument("--template", help="path to an upstream Multiloader-Template checkout for the fidelity test")
    ap.add_argument("--only", help="run just this config name")
    args = ap.parse_args()
    chrome = find_chrome(args.chrome)

    configs = sorted(f for f in os.listdir(CONFIG_DIR) if f.endswith(".json"))
    if args.only:
        configs = [c for c in configs if c[:-5] == args.only]
    failed = 0
    for cfg_file in configs:
        name = cfg_file[:-5]
        with open(os.path.join(CONFIG_DIR, cfg_file), encoding="utf-8") as fh:
            spec = json.load(fh)
        r = Result(name)
        try:
            status, zip_b64 = run_harness(chrome, {"defaults": spec.get("defaults", "ui"), "config": spec.get("config", {})})
            if spec.get("expect") == "invalid":
                fields = sorted({e["field"] for e in status.get("errors", [])})
                expected = sorted(spec.get("errorFields", []))
                r.check(status.get("status") == "invalid", f"expected validation failure, got {status.get('status')}")
                r.check(fields == expected, f"validation errors on {fields}, expected {expected}")
                r.notes.append("negative test: " + ", ".join(e["message"] for e in status.get("errors", []))[:300])
            elif status.get("status") != "ok":
                r.failures.append(f"harness status: {json.dumps(status)[:2000]}")
            else:
                cfg = status["config"]
                zip_bytes = base64.b64decode(zip_b64)
                dest = os.path.join(OUT_DIR, name)
                entries = extract_zip(zip_bytes, dest)
                files = check_flat(entries)
                r.notes.append(f"{status['fileCount']} files, zip {status['zipBytes'] // 1024} KiB -> {os.path.relpath(dest, ROOT)}")
                fidelity = bool(spec.get("checks", {}).get("fidelity"))
                check_common(r, files, cfg, leak_check=not fidelity)
                if fidelity:
                    check_fidelity(r, files, cfg, args.template)
        except Exception as ex:  # noqa: BLE001
            r.failures.append(f"exception: {ex!r}")
        mark = "PASS" if r.ok() else "FAIL"
        print(f"[{mark}] {name}" + (f"  ({'; '.join(r.notes)})" if r.notes else ""))
        for f in r.failures:
            print("    - " + f.replace("\n", "\n      "))
        failed += 0 if r.ok() else 1
    print(f"\n{len(configs) - failed}/{len(configs)} configs passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
