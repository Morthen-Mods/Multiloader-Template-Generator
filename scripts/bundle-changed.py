#!/usr/bin/env python3
"""
Report whether the bundled data files differ from the committed versions in a way that matters.

Both bake scripts stamp their output with the time they ran, so a plain `git diff` is never empty.
This compares js/templates/*.js and js/versions-data.js against HEAD with those timestamps
removed; a snapshot that is new or no longer baked counts as a change too.
Exit code 0 = real changes, 1 = only timestamps changed (nothing worth committing).

With --github-output FILE (used by .github/workflows/refresh.yml) the result is appended to that file
instead and the exit code is always 0:

    changed=true|false              anything worth committing
    snapshots=["1.21.2", ...]       template snapshots whose files changed or are new (they need a Gradle build)
"""
import argparse
import glob
import json
import os
import re
import subprocess
import sys

TEMPLATES = "js/templates"
VERSIONS = "js/versions-data.js"
NOT_SNAPSHOTS = {"manifest", "licenses"}
NOISE = [
    re.compile(r'"bakedAt":\s*"[^"]*"'),
    re.compile(r'"fetchedAt":\s*"[^"]*"'),
    re.compile(r"^// Snapshot of .*$", re.M),
    re.compile(r"^// Bundled version catalog fetched .*$", re.M),
]


def normalize(text):
    for rx in NOISE:
        text = rx.sub("", text)
    return text


def committed(path):
    try:
        return subprocess.check_output(["git", "show", f"HEAD:{path}"], text=True, stderr=subprocess.DEVNULL)
    except subprocess.CalledProcessError:
        return None


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--github-output", metavar="FILE", help="append changed=/snapshots= to this file (GITHUB_OUTPUT)")
    args = ap.parse_args()

    current = sorted(glob.glob(f"{TEMPLATES}/*.js")) + [VERSIONS]
    tracked = subprocess.check_output(["git", "ls-files", "--", f"{TEMPLATES}/*.js"], text=True).split()
    changed = [p for p in tracked if p not in current]  # snapshots of branches that are gone
    for path in current:
        old = committed(path)
        with open(path, encoding="utf-8") as fh:
            new = fh.read()
        if old is None or normalize(old) != normalize(new):
            changed.append(path)

    snapshots = sorted(os.path.basename(p)[:-3] for p in changed
                       if p.startswith(TEMPLATES + "/") and p in current and os.path.basename(p)[:-3] not in NOT_SNAPSHOTS)
    print(("changed: " + ", ".join(changed)) if changed else "unchanged (only timestamps differ)")
    if args.github_output:
        with open(args.github_output, "a", encoding="utf-8") as fh:
            fh.write(f"changed={'true' if changed else 'false'}\n")
            fh.write(f"snapshots={json.dumps(snapshots)}\n")
        return 0
    return 0 if changed else 1


if __name__ == "__main__":
    sys.exit(main())
