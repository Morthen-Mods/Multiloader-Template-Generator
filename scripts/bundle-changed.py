#!/usr/bin/env python3
"""
Report whether the bundled data files differ from the committed versions in a way that matters.

Both bake scripts stamp their output with the time they ran, so a plain `git diff` is never empty.
This compares js/templates/*.js and js/versions-data.js against HEAD with those timestamps
removed. Exit code 0 = real changes, 1 = only timestamps changed (nothing worth committing).
Used by .github/workflows/refresh.yml.
"""
import glob
import re
import subprocess
import sys

FILES = sorted(glob.glob("js/templates/*.js")) + ["js/versions-data.js"]
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


def main():
    changed = []
    for path in FILES:
        try:
            old = subprocess.check_output(["git", "show", f"HEAD:{path}"], text=True, stderr=subprocess.DEVNULL)
        except subprocess.CalledProcessError:
            changed.append(path)  # not committed yet
            continue
        with open(path, encoding="utf-8") as fh:
            new = fh.read()
        if normalize(old) != normalize(new):
            changed.append(path)
    if changed:
        print("changed: " + ", ".join(changed))
        return 0
    print("unchanged (only timestamps differ)")
    return 1


if __name__ == "__main__":
    sys.exit(main())
