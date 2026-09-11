#!/usr/bin/env python3
"""
Bake the Multiloader-Template repository into js/template-data.js.

The generator web app is fully static: it does not clone anything at runtime.
Instead this script snapshots the template (plus the license texts under
licenses/) into a single classic-script JS file that index.html loads.

Usage:
    scripts/bake.py                      # clone the template from GitHub (default branch)
    scripts/bake.py --ref v1.2.3         # clone a specific tag / branch / commit
    scripts/bake.py --source ../Multiloader-Template   # use a local checkout instead

Re-run this whenever the upstream template changes, then commit the regenerated
js/template-data.js.
"""
import argparse
import base64
import datetime as dt
import json
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_REPO = "https://github.com/Morthen-Mods/Multiloader-Template"
OUTPUT = os.path.join(ROOT, "js", "template-data.js")
LICENSE_DIR = os.path.join(ROOT, "licenses")

# Paths (relative, "/"-separated) that never make it into the snapshot.
EXCLUDED_DIRS = {".git", ".idea", ".gradle", "build", "run"}
EXCLUDED_FILES = set()
BINARY_EXT = {".jar", ".png", ".jpg", ".jpeg", ".gif", ".ogg", ".zip", ".class", ".ico"}


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
        # prune excluded directories in-place so os.walk skips them
        dirnames[:] = sorted(d for d in dirnames if d not in EXCLUDED_DIRS)
        for name in sorted(filenames):
            rel = name if rel_dir == "." else f"{rel_dir}/{name}"
            rel = rel.replace(os.sep, "/")
            if rel in EXCLUDED_FILES:
                continue
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


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--repo", default=DEFAULT_REPO, help="git URL of the template (default: %(default)s)")
    parser.add_argument("--ref", default=None, help="branch, tag or commit to snapshot (default: remote HEAD)")
    parser.add_argument("--source", default=None, help="use an existing local checkout instead of cloning")
    parser.add_argument("--output", default=OUTPUT, help="where to write the JS snapshot (default: %(default)s)")
    args = parser.parse_args()

    tmp = None
    try:
        if args.source:
            source = os.path.abspath(args.source)
        else:
            tmp = tempfile.mkdtemp(prefix="multiloader-template-")
            source = os.path.join(tmp, "template")
            clone_args = ["clone", "--quiet", args.repo, source]
            if args.ref:
                # need history to resolve arbitrary refs
                subprocess.check_call(["git", *clone_args])
                subprocess.check_call(["git", "checkout", "--quiet", args.ref], cwd=source)
            else:
                subprocess.check_call(["git", *clone_args, "--depth", "1"])

        commit = git(["rev-parse", "HEAD"], source)
        commit_date = git(["log", "-1", "--format=%cI"], source)
        try:
            remote = git(["config", "--get", "remote.origin.url"], source)
        except subprocess.CalledProcessError:
            remote = args.repo

        files = collect(source)
        licenses = collect_licenses()

        payload = {
            "source": remote,
            "commit": commit,
            "commitDate": commit_date,
            "bakedAt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
            "files": files,
        }

        os.makedirs(os.path.dirname(args.output), exist_ok=True)
        with open(args.output, "w", encoding="utf-8", newline="\n") as fh:
            fh.write("// GENERATED FILE - do not edit by hand. Regenerate with scripts/bake.py\n")
            fh.write(f"// Snapshot of {remote} @ {commit[:12]} ({commit_date})\n")
            fh.write("window.TEMPLATE_DATA = ")
            json.dump(payload, fh, ensure_ascii=False, indent=1, sort_keys=False)
            fh.write(";\n")
            fh.write("window.LICENSE_DATA = ")
            json.dump(licenses, fh, ensure_ascii=False, indent=1)
            fh.write(";\n")

        text_count = sum(1 for f in files.values() if "text" in f)
        bin_count = len(files) - text_count
        size = os.path.getsize(args.output)
        print(f"baked {len(files)} files ({text_count} text, {bin_count} binary) from {commit[:12]} "
              f"and {len(licenses)} license texts -> {os.path.relpath(args.output, ROOT)} ({size // 1024} KiB)")
        return 0
    finally:
        if tmp:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
