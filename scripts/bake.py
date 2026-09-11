#!/usr/bin/env python3
"""
Bake the Multiloader-Template repository into js/templates/.

The generator web app is fully static: it does not clone anything at runtime.
This script snapshots every template branch into its own classic-script JS file,
plus a small manifest that index.html loads up front.

One snapshot per Minecraft version line:

    js/templates/manifest.js   window.TEMPLATE_MANIFEST - which version uses which snapshot
    js/templates/licenses.js   window.LICENSE_DATA - SPDX texts, shared by every snapshot
    js/templates/26.2.js       window.TEMPLATE_SNAPSHOTS["26.2"] - the files of that branch
    js/templates/26.1.js       ...

Branches whose name looks like a version ("26.2", "21.1", "1.21.1") are treated as
version lines; every other branch is ignored. The Minecraft version a snapshot serves
is read from its own gradle.properties, NOT from the branch name, so a branch may be
named anything. The default branch is always baked as the fallback.

Usage:
    scripts/bake.py                        # clone from GitHub, bake every version branch
    scripts/bake.py --source ../Template   # use an existing local checkout instead
    scripts/bake.py --branches main 26.2   # only these branches

Re-run this whenever the upstream template changes, then commit js/templates/.
"""
import argparse
import base64
import datetime as dt
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_REPO = "https://github.com/Morthen-Mods/Multiloader-Template"
OUTPUT_DIR = os.path.join(ROOT, "js", "templates")
LICENSE_DIR = os.path.join(ROOT, "licenses")

# Paths (relative, "/"-separated) that never make it into a snapshot.
EXCLUDED_DIRS = {".git", ".idea", ".gradle", "build", "run"}
BINARY_EXT = {".jar", ".png", ".jpg", ".jpeg", ".gif", ".ogg", ".zip", ".class", ".ico"}

# A branch name that looks like a version line, e.g. "26.2", "21.1", "1.21.1".
VERSION_BRANCH_RE = re.compile(r"^\d+(\.\d+)*$")


def is_binary(path: str) -> bool:
    if os.path.splitext(path)[1].lower() in BINARY_EXT:
        return True
    with open(path, "rb") as fh:
        chunk = fh.read(8192)
    return b"\0" in chunk


def git(args, cwd):
    return subprocess.check_output(["git", *args], cwd=cwd, text=True).strip()


def collect(source_dir: str) -> dict:
    files = {}
    for dirpath, dirnames, filenames in os.walk(source_dir):
        rel_dir = os.path.relpath(dirpath, source_dir)
        dirnames[:] = sorted(d for d in dirnames if d not in EXCLUDED_DIRS)
        for name in sorted(filenames):
            rel = name if rel_dir == "." else f"{rel_dir}/{name}"
            rel = rel.replace(os.sep, "/")
            full = os.path.join(dirpath, name)
            if is_binary(full):
                with open(full, "rb") as fh:
                    files[rel] = {"base64": base64.b64encode(fh.read()).decode("ascii")}
            else:
                with open(full, "r", encoding="utf-8", newline="") as fh:
                    files[rel] = {"text": fh.read()}
    return files


def collect_licenses() -> dict:
    out = {}
    for name in sorted(os.listdir(LICENSE_DIR)):
        if name.endswith(".txt"):
            with open(os.path.join(LICENSE_DIR, name), "r", encoding="utf-8", newline="") as fh:
                out[name[:-4]] = fh.read()
    return out


def parse_properties(text: str) -> dict:
    out = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or line.startswith("!"):
            continue
        if "=" in line:
            k, _, v = line.partition("=")
            out[k.strip()] = v.strip()
    return out


def describe_template(files: dict, branch: str) -> dict:
    """
    Work out how this branch names its example mod, so the generator can rename it.
    Derived from the checkout itself rather than hard-coded, so an upstream rename
    does not need a code change here.
    """
    def text(path):
        entry = files.get(path)
        return entry["text"] if entry and "text" in entry else None

    props_text = text("gradle.properties")
    if props_text is None:
        raise SystemExit(f"{branch}: no gradle.properties in the checkout")
    props = parse_properties(props_text)
    for key in ("mod_id", "mod_name", "minecraft_version"):
        if not props.get(key):
            raise SystemExit(f"{branch}: gradle.properties has no {key}")

    # package: the directory holding CommonConstants.java
    prefix = "common/src/main/java/"
    const_files = [p for p in files if p.startswith(prefix) and p.endswith("/CommonConstants.java")]
    if len(const_files) != 1:
        raise SystemExit(f"{branch}: expected exactly one common CommonConstants.java, found {const_files}")
    package_dir = const_files[0][len(prefix):-len("CommonConstants.java")]   # "com/example/example_mod/"
    package_name = package_dir.strip("/").replace("/", ".")

    # class prefix: the loader entrypoint "<prefix>Mod.java" next to the package root
    candidates = set()
    for loader in ("fabric", "forge", "neoforge"):
        root = f"{loader}/src/main/java/{package_dir}"
        for p in files:
            if p.startswith(root) and p.endswith("Mod.java") and "/" not in p[len(root):]:
                candidates.add(os.path.basename(p)[: -len("Mod.java")])
    if len(candidates) != 1 or not candidates != {""}:
        raise SystemExit(f"{branch}: could not determine the class prefix, candidates {sorted(candidates)}")
    class_prefix = candidates.pop()

    # cross-check against the datagen provider, when that module is present
    provider = f"datagen/src/main/java/{package_dir}provider/{class_prefix}Provider.java"
    if any(p.startswith("datagen/") for p in files) and provider not in files:
        raise SystemExit(f"{branch}: class prefix '{class_prefix}' does not match, expected {provider}")

    return {
        "modId": props["mod_id"],
        "modName": props["mod_name"],
        "classPrefix": class_prefix,
        "packageName": package_name,
        "packageDir": package_dir,
        "minecraftVersion": props["minecraft_version"],
    }


def content_key(files: dict) -> str:
    blob = json.dumps(files, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha1(blob).hexdigest()


def write_snapshot(path: str, key: str, payload: dict):
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("// GENERATED FILE - do not edit by hand. Regenerate with scripts/bake.py\n")
        fh.write(f"// Snapshot of {payload['source']} @ {payload['commit'][:12]} ({payload['commitDate']})\n")
        fh.write("window.TEMPLATE_SNAPSHOTS = window.TEMPLATE_SNAPSHOTS || {};\n")
        fh.write(f"window.TEMPLATE_SNAPSHOTS[{json.dumps(key)}] = ")
        json.dump(payload, fh, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        fh.write(";\n")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--repo", default=DEFAULT_REPO, help="git URL of the template (default: %(default)s)")
    parser.add_argument("--source", default=None, help="use an existing local checkout instead of cloning")
    parser.add_argument("--branches", nargs="*", default=None, help="only bake these branches")
    parser.add_argument("--output", default=OUTPUT_DIR, help="where to write the snapshots (default: %(default)s)")
    args = parser.parse_args()

    tmp = None
    try:
        if args.source:
            source = os.path.abspath(args.source)
        else:
            tmp = tempfile.mkdtemp(prefix="multiloader-template-")
            source = os.path.join(tmp, "template")
            subprocess.check_call(["git", "clone", "--quiet", args.repo, source])

        remote = args.repo
        try:
            remote = git(["config", "--get", "remote.origin.url"], source)
        except subprocess.CalledProcessError:
            pass

        default_branch = git(["rev-parse", "--abbrev-ref", "origin/HEAD"], source).split("/")[-1]
        # the remote branches, minus the origin/HEAD symref; fall back to local ones for a checkout without a remote
        def branches_under(prefix, ref_root):
            refs = git(["for-each-ref", "--format=%(refname)", ref_root], source).splitlines()
            return [r[len(prefix):] for r in refs if r.startswith(prefix) and not r.endswith("/HEAD")]
        all_branches = branches_under("refs/remotes/origin/", "refs/remotes/origin")
        if not all_branches:
            all_branches = branches_under("refs/heads/", "refs/heads")
        wanted = args.branches or [b for b in all_branches if b == default_branch or VERSION_BRANCH_RE.match(b)]
        wanted = sorted(set(wanted), key=lambda b: (b != default_branch, b))
        if default_branch not in wanted:
            raise SystemExit(f"the default branch '{default_branch}' must be baked as the fallback")

        # say out loud which branches are not baked, so a misnamed version branch is noticed
        skipped = [b for b in all_branches if b not in wanted]
        if skipped:
            print(f"skipping branches (no version-shaped name): {', '.join(sorted(skipped))}")

        licenses = collect_licenses()
        baked_at = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")

        entries = {}          # manifest key -> entry
        by_content = {}       # content hash -> snapshot key (so identical branches share one file)
        snapshots = {}        # snapshot key -> payload

        for branch in wanted:
            subprocess.check_call(["git", "checkout", "--quiet", branch], cwd=source)
            files = collect(source)
            info = describe_template(files, branch)
            mc = info.pop("minecraftVersion")
            is_default = branch == default_branch
            manifest_key = "default" if is_default else mc

            digest = content_key(files)
            if digest in by_content:
                snapshot_key = by_content[digest]                 # same content as an earlier branch
            else:
                snapshot_key = "default" if is_default else mc
                by_content[digest] = snapshot_key
                snapshots[snapshot_key] = {
                    "source": remote,
                    "branch": branch,
                    "commit": git(["rev-parse", "HEAD"], source),
                    "commitDate": git(["log", "-1", "--format=%cI"], source),
                    "bakedAt": baked_at,
                    "template": info,
                    "files": files,
                }
            if manifest_key in entries:
                raise SystemExit(f"branches '{entries[manifest_key]['branch']}' and '{branch}' both declare "
                                 f"minecraft_version={mc}; give them distinct target versions")
            entries[manifest_key] = {
                "branch": branch,
                "minecraftVersion": mc,
                "snapshot": snapshot_key,
                "commit": git(["rev-parse", "HEAD"], source),
                "commitDate": git(["log", "-1", "--format=%cI"], source),
                "template": info,
            }
            print(f"{branch:<12} -> Minecraft {mc:<10} snapshot '{snapshot_key}'"
                  f"{'  (shared)' if snapshots.get(snapshot_key, {}).get('branch') != branch else ''}"
                  f"  mod {info['modId']} / {info['packageName']} / {info['classPrefix']}")

        os.makedirs(args.output, exist_ok=True)
        for name in os.listdir(args.output):
            if name.endswith(".js"):
                os.remove(os.path.join(args.output, name))

        licenses_path = os.path.join(args.output, "licenses.js")
        with open(licenses_path, "w", encoding="utf-8", newline="\n") as fh:
            fh.write("// GENERATED FILE - do not edit by hand. Regenerate with scripts/bake.py\n")
            fh.write("window.LICENSE_DATA = ")
            json.dump(licenses, fh, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
            fh.write(";\n")
        print(f"  wrote {os.path.relpath(licenses_path, ROOT)} ({os.path.getsize(licenses_path) // 1024} KiB, {len(licenses)} licenses)")

        total = 0
        for key, payload in sorted(snapshots.items()):
            path = os.path.join(args.output, f"{key}.js")
            write_snapshot(path, key, payload)
            total += os.path.getsize(path)
            print(f"  wrote {os.path.relpath(path, ROOT)} ({os.path.getsize(path) // 1024} KiB, {len(payload['files'])} files)")

        manifest = {
            "source": remote,
            "bakedAt": baked_at,
            "defaultBranch": default_branch,
            "entries": entries,
        }
        manifest_path = os.path.join(args.output, "manifest.js")
        with open(manifest_path, "w", encoding="utf-8", newline="\n") as fh:
            fh.write("// GENERATED FILE - do not edit by hand. Regenerate with scripts/bake.py\n")
            fh.write("window.TEMPLATE_MANIFEST = ")
            json.dump(manifest, fh, ensure_ascii=False, indent=1, sort_keys=True)
            fh.write(";\n")
        print(f"  wrote {os.path.relpath(manifest_path, ROOT)} ({len(entries)} entries, {len(snapshots)} snapshots, {total // 1024} KiB total)")
        return 0
    finally:
        if tmp:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
