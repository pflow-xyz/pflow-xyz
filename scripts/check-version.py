#!/usr/bin/env python3
"""Fail the build if the version shown in the UI drifts from package.json.

public/petri-view.js is served to the browser verbatim — there is no build step
that could inject a version — so the number rendered in the hamburger footer has
to be a literal in the source. That makes it a second copy of something
package.json already records, and second copies rot silently: the menu would
happily show v1.23.0 forever while releases moved on.

A release bumps package.json and cuts an annotated tag (see `git show v1.23.0`).
This check ties the third copy to the first. The tag itself is deliberately NOT
checked: the working tree is normally some commits ahead of the last tag, and
failing every non-release build would just train people to ignore this.
"""

import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
PKG = ROOT / "package.json"
JS = ROOT / "public" / "petri-view.js"

VERSION_RE = re.compile(r"static\s+VERSION\s*=\s*['\"]([^'\"]+)['\"]")


def main() -> int:
    pkg_version = json.loads(PKG.read_text())["version"]

    match = VERSION_RE.search(JS.read_text())
    if not match:
        print("check-version: FAIL")
        print(f"  - no `static VERSION = '...'` found in {JS.relative_to(ROOT)}")
        return 1
    js_version = match.group(1)

    if js_version != pkg_version:
        print("check-version: FAIL")
        print(f"  - package.json says {pkg_version}")
        print(f"  - petri-view.js  says {js_version}")
        print("  - a release bumps both; update PetriView.VERSION to match")
        return 1

    print(f"check-version: ok (v{pkg_version})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
