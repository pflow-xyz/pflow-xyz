#!/usr/bin/env python3
"""Guard the design-token contract in public/petri-view.css.

Three failures this prevents, all of which have actually happened here:

  1. A semantic token defined for light with no dark counterpart, so the
     element silently stays light in dark mode (--pv-success did this).
  2. The two dark paths - prefers-color-scheme and data-theme="dark" -
     disagreeing, so the OS setting and the explicit attribute render
     differently.
  3. A component hardcoding a color instead of using a token, which is how
     the JSON editor, mode menu and scale meter stayed white in dark mode.

The diagram canvas is deliberately exempt: .pv-canvas-container pins the light
"paper" palette in both themes so canvas-drawn arcs and nodes stay readable,
and elements rendered onto it inherit that on purpose.
"""
import re
import sys
from collections import Counter
from pathlib import Path

CSS = Path(__file__).resolve().parent.parent / "public" / "petri-view.css"

# Selectors that render onto the pinned-light canvas.
CANVAS = (
    "pv-place", "pv-transition", "pv-arc", "pv-label", "pv-inhibit", "pv-token",
    "pv-group-selected", "pv-stage", "pv-node", "pv-handle", "pv-selection",
    "pv-guide", "pv-ghost", "pv-marker", "pv-snap", "pv-weight",
)

# Tokens that are the same in both themes on purpose, so "missing a dark
# counterpart" is the intended state rather than a bug.
#   --pv-paper  : the diagram's light "paper" ground.
#   --pv-brand-*: the marketing shell, dark in both themes by design.
THEME_INVARIANT = ("--pv-paper", "--pv-brand-")

# Pages whose inline <style> must also theme through tokens.
INLINE_STYLE_PAGES = ("index.html",)

COLOR = re.compile(r"(#[0-9a-fA-F]{3,8}\b|rgba?\([\d\s.,%]*\))")
SEL = re.compile(r"^([.#&:\w\[][^{}]*)\{\s*$")
DECL = re.compile(r"^\s*(--pv-[a-z0-9-]+)\s*:", re.M)


def block(src, pattern):
    m = re.search(pattern, src, re.S)
    if not m:
        sys.exit(f"check-theme-tokens: could not locate block /{pattern}/ in {CSS}")
    return m.group(1)


def main():
    src = CSS.read_text()
    failures = []

    root = block(src, r":root \{\n(.*?)\n\}")
    light = {
        t for t in DECL.findall(root)
        if not t.startswith("--pv-d-") and not t.startswith(THEME_INVARIANT)
    }
    media = block(
        src,
        r"@media \(prefers-color-scheme: dark\) \{\n    :root:where[^\n]*\n(.*?)\n    \}",
    )
    dtheme = block(src, r':root\[data-theme="dark"\] \{\n(.*?)\n\}')
    dm, dt = DECL.findall(media), DECL.findall(dtheme)

    for label, names in (("prefers-color-scheme", dm), ('data-theme="dark"', dt)):
        dupes = [k for k, v in Counter(names).items() if v > 1]
        if dupes:
            failures.append(f"{label} block defines {len(dupes)} token(s) twice: {', '.join(sorted(dupes))}")
        missing = sorted(light - set(names))
        if missing:
            failures.append(f"{label} block is missing {len(missing)} token(s): {', '.join(missing)}")

    if set(dm) != set(dt):
        diff = sorted(set(dm) ^ set(dt))
        failures.append(f"the two dark blocks disagree on: {', '.join(diff)}")

    used = set(re.findall(r"var\((--pv-[a-z0-9-]+)", src))
    defined = set(DECL.findall(src))
    undefined = sorted(used - defined)
    if undefined:
        failures.append(f"undefined token(s) referenced: {', '.join(undefined)}")

    # hardcoded colors in chrome rules
    stack, offenders = [], []
    for i, line in enumerate(src.split("\n"), 1):
        s = line.strip()
        if s.startswith("@media"):
            stack.append(("media", s))
            continue
        m = SEL.match(s)
        if m:
            stack.append(("rule", m.group(1).strip()))
            continue
        if s.startswith("}"):
            if stack:
                stack.pop()
            continue
        if any("dark" in x for k, x in stack if k == "media"):
            continue
        rules = [x for k, x in stack if k == "rule"]
        rule = rules[-1] if rules else ""
        if not rule or rule == ":root" or "data-theme" in rule:
            continue
        if any(k in rule for k in CANVAS):
            continue
        if COLOR.search(line):
            offenders.append(f"  {i}: {rule} -> {s[:70]}")
    if offenders:
        failures.append(
            "hardcoded color(s) in themed chrome; use a --pv-* token:\n" + "\n".join(offenders)
        )

    # Inline <style> on the shipped pages must theme through tokens too, or the
    # landing page drifts from the editor the way it already had once.
    for page in INLINE_STYLE_PAGES:
        path = CSS.parent / page
        if not path.exists():
            failures.append(f"{page}: expected to exist for the inline-style check")
            continue
        inline = "\n".join(re.findall(r"<style[^>]*>(.*?)</style>", path.read_text(), re.S))
        stray = COLOR.findall(inline)
        if stray:
            failures.append(
                f"{page}: {len(stray)} hardcoded color(s) in inline <style>; "
                f"alias a --pv-* token instead: {', '.join(sorted(set(stray))[:6])}"
            )

    if failures:
        print("check-theme-tokens: FAIL")
        for f in failures:
            print("  - " + f)
        sys.exit(1)
    print(f"check-theme-tokens: ok ({len(light)} tokens, both dark paths complete and in agreement)")


if __name__ == "__main__":
    main()
