"""Publish a page, model, or artifact directory to cdn.stackdump.com.

Stages files into ~/Workspace/cdn-stackdump-com/data/blobs/<cid>/, writes an
index.md whose frontmatter is the metadata of record, pings the local indexer,
and triggers mirror-push.sh to sync to pflow.dev. Public URL is then
https://cdn.stackdump.com/ipfs/<cid>/.

Follows the producer contract in ~/Workspace/CLAUDE.md ("Publishing content to
cdn-stackdump-com"). Shaped after beats-builder/publish/cdn.py, generalized:
this one takes arbitrary files rather than a beats share envelope.

Library use (best-effort — logs and returns None on failure, never raises):

    from publish.cdn import publish
    cid = publish("demo.html", title="My demo", schema="InteractiveDemo/v1")

CLI use (strict — non-zero exit on failure):

    python3 publish/cdn.py demo.html --title "My demo" --tag ode --tag demo
    python3 publish/cdn.py ./artifact-dir/ --schema PetriNet/v1 --draft
    python3 publish/cdn.py model.jsonld --body notes.md --meta solver=tsit5

Two conventions this encodes so callers don't have to remember them:

  * The CID is `bafyrei` + the first 32 hex of sha256 over the primary
    artifact's bytes — the house rule used across the ecosystem (see
    beats-builder/scripts/recording/publish.py). The CDN sanitises rather
    than validates the string, so this is a content address, not a real CIDv1.
  * A file named `index.html` is renamed to `demo.html` on staging. The CDN's
    file server 301s `/ipfs/<cid>/index.html` to `./`, which renders the
    index.md landing page — so an artifact literally named index.html is
    unreachable, and the landing page's link to it is a redirect loop.
"""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from datetime import datetime, timezone

_DEFAULT_BLOBS = pathlib.Path.home() / "Workspace" / "cdn-stackdump-com" / "data" / "blobs"
_DEFAULT_RELOAD = "http://127.0.0.1:18091/admin/reload"
_DEFAULT_MIRROR = pathlib.Path.home() / "Workspace" / "cdn-stackdump-com" / "bin" / "mirror-push.sh"

SOURCE = "pflow-xyz"
PUBLIC_BASE = "https://cdn.stackdump.com/ipfs"

# index.html is unreachable once staged — see module docstring.
RESERVED_NAMES = {"index.html": "demo.html"}

# Files that never belong in a published artifact.
SKIP_NAMES = {".DS_Store", "Thumbs.db"}


# ---------------------------------------------------------------- environment

def _enabled() -> bool:
    """CDN_PUBLISH_ENABLED=0 disables. Otherwise enabled iff the CDN tree exists."""
    flag = os.environ.get("CDN_PUBLISH_ENABLED")
    if flag is not None:
        return flag not in ("0", "", "false", "no")
    return _blobs_dir().parent.exists()


def _blobs_dir() -> pathlib.Path:
    return pathlib.Path(os.environ.get("CDN_BLOBS_DIR", str(_DEFAULT_BLOBS)))


def _reload_url() -> str:
    return os.environ.get("CDN_RELOAD_URL", _DEFAULT_RELOAD)


def _mirror_push_path() -> pathlib.Path | None:
    override = os.environ.get("CDN_MIRROR_PUSH")
    if override is not None:
        return None if override == "" else pathlib.Path(override)
    return _DEFAULT_MIRROR


# ------------------------------------------------------------------- helpers

def compute_cid(data: bytes) -> str:
    """House content address: bafyrei + first 32 hex of sha256(data)."""
    return "bafyrei" + hashlib.sha256(data).hexdigest()[:32]


def _yaml_str(s: str) -> str:
    """Conservative YAML scalar quoting."""
    if not s:
        return '""'
    if any(c in s for c in ":#[]{},&*!|>'\"%@`") or s != s.strip():
        return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'
    return s


def _yaml_scalar(v) -> str:
    """Render a --meta value as the narrowest YAML type it parses as."""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return str(v)
    s = str(v)
    if re.fullmatch(r"-?\d+", s):
        return s
    if re.fullmatch(r"-?\d*\.\d+", s):
        return s
    if s.lower() in ("true", "false"):
        return s.lower()
    return _yaml_str(s)


def _collect(src: pathlib.Path) -> list[pathlib.Path]:
    """Files to publish, relative to src (a file yields itself)."""
    if src.is_file():
        return [src]
    out = []
    for p in sorted(src.rglob("*")):
        if p.is_file() and p.name not in SKIP_NAMES:
            out.append(p)
    return out


def _pick_primary(files: list[pathlib.Path], src: pathlib.Path) -> pathlib.Path:
    """The artifact whose bytes define the CID.

    Prefers a top-level index.html/demo.html, then any top-level html, then
    a top-level json/jsonld, then the largest file — deterministic in all cases.
    """
    def rel(p):
        return p if src.is_file() else p.relative_to(src)

    top = [p for p in files if len(rel(p).parts) == 1] or files
    for want in ("index.html", "demo.html"):
        for p in top:
            if p.name == want:
                return p
    for suffixes in ((".html",), (".jsonld", ".json"), (".md",)):
        cands = [p for p in top if p.suffix in suffixes and p.name != "index.md"]
        if cands:
            return sorted(cands)[0]
    return max(files, key=lambda p: (p.stat().st_size, p.name))


def _infer_schema(primary: pathlib.Path, data: bytes) -> str:
    if primary.suffix == ".html":
        return "InteractiveDemo/v1"
    if primary.suffix in (".json", ".jsonld"):
        try:
            obj = json.loads(data)
            if isinstance(obj, dict) and obj.get("@type") == "PetriNet":
                return "PetriNet/v1"
        except (json.JSONDecodeError, UnicodeDecodeError):
            pass
        return "Dataset/v1"
    if primary.suffix in (".md", ".txt"):
        return "Document/v1"
    return "Artifact/v1"


def _infer_title(primary: pathlib.Path, data: bytes) -> str:
    if primary.suffix == ".html":
        m = re.search(rb"<title[^>]*>(.*?)</title>", data, re.S | re.I)
        if m:
            title = html.unescape(m.group(1).decode("utf-8", "replace")).strip()
            title = re.sub(r"\s+", " ", title)
            # Strip a trailing site suffix like " — cdn.stackdump.com"
            return re.sub(r"\s+[—|-]\s+[\w.]+$", "", title) or primary.stem
    if primary.suffix in (".json", ".jsonld"):
        try:
            obj = json.loads(data)
            for key in ("title", "name"):
                if isinstance(obj, dict) and isinstance(obj.get(key), str):
                    return obj[key]
        except (json.JSONDecodeError, UnicodeDecodeError):
            pass
    return primary.stem.replace("-", " ").replace("_", " ").strip() or primary.name


def _role_for(name: str, primary_name: str) -> str:
    if name == primary_name:
        return "primary"
    if name.endswith((".png", ".jpg", ".jpeg", ".svg", ".webp")):
        return "asset"
    return "supporting"


def _render_index_md(
    cid: str,
    title: str,
    schema: str,
    staged: list[str],
    primary_name: str,
    *,
    tags: list[str],
    meta: dict,
    body: str,
    draft: bool,
    parents: list[str],
) -> str:
    lines = [
        "---",
        f"title: {_yaml_str(title)}",
        f"cid: {cid}",
        f"source: {SOURCE}",
        f"schema: {schema}",
        f"publishedAt: {datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}",
    ]
    for k, v in meta.items():
        lines.append(f"{k}: {_yaml_scalar(v)}")
    lines.append(f"draft: {'true' if draft else 'false'}")
    if tags:
        lines.append("tags:")
        lines.extend(f"  - {t}" for t in tags)
    if parents:
        lines.append("parents:")
        lines.extend(f"  - {p}" for p in parents)
    lines.append("artifacts:")
    for name in staged:
        lines.append(f"  - path: {name}")
        lines.append(f"    role: {_role_for(name, primary_name)}")
    lines.append("---")
    lines.append("")
    lines.append(f"# {title}")
    lines.append("")

    if primary_name.endswith(".html"):
        lines.append(f"**[▶ Open the interactive demo]({primary_name})**")
        lines.append("")

    if body.strip():
        lines.append(body.strip())
        lines.append("")

    others = [n for n in staged if n != primary_name]
    if others:
        lines.append("## Files")
        lines.append("")
        lines.extend(f"- [`{n}`]({n})" for n in others)
        lines.append("")
    return "\n".join(lines)


def _ping_reload(cid: str) -> bool:
    url = f"{_reload_url()}?cid={cid}"
    try:
        with urllib.request.urlopen(urllib.request.Request(url, method="POST"), timeout=5) as r:
            return 200 <= r.status < 300
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        print(f"  ! cdn publish: reload {url} failed ({e})", file=sys.stderr)
        return False


def _mirror(wait: bool) -> None:
    mirror = _mirror_push_path()
    if mirror is None or not mirror.exists() or not os.access(mirror, os.X_OK):
        return
    try:
        if wait:
            subprocess.run([str(mirror)], check=False,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        else:
            subprocess.Popen([str(mirror)], start_new_session=True,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except OSError as e:
        print(f"  ! cdn publish: mirror-push failed ({e})", file=sys.stderr)


# -------------------------------------------------------------------- publish

def publish(
    src,
    *,
    title: str | None = None,
    schema: str | None = None,
    tags: list[str] | None = None,
    meta: dict | None = None,
    body: str = "",
    draft: bool = False,
    parents: list[str] | None = None,
    mirror: bool = True,
    wait_for_mirror: bool = False,
    dry_run: bool = False,
) -> str | None:
    """Stage `src` (a file or directory) under the CDN tree and trigger sync.

    Returns the CID on success, None on any failure (logged, never raised) so a
    caller's main flow is never blocked by the CDN being unavailable.
    """
    src = pathlib.Path(src).expanduser()
    if not src.exists():
        print(f"  ! cdn publish: {src} does not exist", file=sys.stderr)
        return None
    if not dry_run and not _enabled():
        print("  cdn publish: disabled (CDN_PUBLISH_ENABLED=0 or CDN tree missing)")
        return None

    files = _collect(src)
    if not files:
        print(f"  ! cdn publish: no files under {src}", file=sys.stderr)
        return None

    primary = _pick_primary(files, src)
    data = primary.read_bytes()
    cid = compute_cid(data)
    title = title or _infer_title(primary, data)
    schema = schema or _infer_schema(primary, data)

    # Map source paths to their staged names, applying the reserved-name rule.
    staged_names = {}
    for p in files:
        rel = p.name if src.is_file() else str(p.relative_to(src))
        if rel == "index.md":
            continue  # regenerated below; a supplied one is read as the body
        staged_names[p] = RESERVED_NAMES.get(rel, rel)
    primary_name = staged_names[primary]

    # A source index.md becomes the markdown body (frontmatter stripped).
    if not body:
        for p in files:
            rel = p.name if src.is_file() else str(p.relative_to(src))
            if rel == "index.md":
                text = p.read_text(encoding="utf-8")
                body = re.sub(r"\A---\n.*?\n---\n", "", text, count=1, flags=re.S)
                break

    index_md = _render_index_md(
        cid, title, schema, sorted(staged_names.values()), primary_name,
        tags=tags or [], meta=meta or {}, body=body, draft=draft,
        parents=parents or [],
    )

    if dry_run:
        print(f"cid:    {cid}")
        print(f"title:  {title}")
        print(f"schema: {schema}")
        print(f"files:  {', '.join(sorted(staged_names.values()))}")
        print(f"url:    {PUBLIC_BASE}/{cid}/")
        if primary_name != (primary.name if src.is_file() else str(primary.relative_to(src))):
            print(f"note:   renamed {primary.name} -> {primary_name} (index.html is unreachable)")
        print("--- index.md ---")
        print(index_md)
        return cid

    blobs = _blobs_dir()
    try:
        blobs.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        print(f"  ! cdn publish: cannot create {blobs} ({e})", file=sys.stderr)
        return None

    # Stage into a sibling tempdir, then swap into place — a scan that races a
    # partially-written directory would index a half-entry.
    tmp = None
    try:
        tmp = pathlib.Path(tempfile.mkdtemp(prefix=f".staging-{cid}-", dir=blobs))
        for p, name in staged_names.items():
            dest = tmp / name
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(p, dest)
        (tmp / "index.md").write_text(index_md, encoding="utf-8")

        target = blobs / cid
        if target.exists():
            shutil.rmtree(target)  # idempotent republish: same bytes, same CID
        tmp.rename(target)
        tmp = None
    except OSError as e:
        print(f"  ! cdn publish: stage failed for {cid} ({e})", file=sys.stderr)
        return None
    finally:
        if tmp is not None and tmp.exists():
            shutil.rmtree(tmp, ignore_errors=True)

    reload_ok = _ping_reload(cid)
    if mirror:
        _mirror(wait_for_mirror)

    print(f"  cdn: staged {cid}{'' if reload_ok else '  (reload failed)'}")
    print(f"  url: {PUBLIC_BASE}/{cid}/")
    return cid


# ------------------------------------------------------------------------ CLI

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description="Publish a file or directory to cdn.stackdump.com.",
        epilog="Public URL is https://cdn.stackdump.com/ipfs/<cid>/ once mirrored.",
    )
    ap.add_argument("src", help="file or directory to publish")
    ap.add_argument("--title", help="defaults to the HTML <title>, JSON title/name, or filename")
    ap.add_argument("--schema", help="TypeName/vN; defaults by content (InteractiveDemo/v1, PetriNet/v1, …)")
    ap.add_argument("--tag", action="append", default=[], dest="tags")
    ap.add_argument("--meta", action="append", default=[], metavar="KEY=VALUE",
                    help="extra frontmatter scalar; becomes a searchable facet")
    ap.add_argument("--parent", action="append", default=[], dest="parents",
                    help="parent CID for lineage (repeatable, newest first)")
    ap.add_argument("--body", help="markdown file for the landing-page body")
    ap.add_argument("--draft", action="store_true", help="hide from feed/search")
    ap.add_argument("--no-mirror", action="store_true", help="skip the rsync to pflow.dev")
    ap.add_argument("--wait", action="store_true", help="wait for mirror-push instead of backgrounding")
    ap.add_argument("--dry-run", action="store_true", help="print the CID and index.md, write nothing")
    args = ap.parse_args(argv)

    meta = {}
    for item in args.meta:
        if "=" not in item:
            print(f"error: --meta expects KEY=VALUE, got {item!r}", file=sys.stderr)
            return 2
        k, v = item.split("=", 1)
        meta[k.strip()] = v.strip()

    body = ""
    if args.body:
        body = pathlib.Path(args.body).expanduser().read_text(encoding="utf-8")

    cid = publish(
        args.src, title=args.title, schema=args.schema, tags=args.tags, meta=meta,
        body=body, draft=args.draft, parents=args.parents,
        mirror=not args.no_mirror, wait_for_mirror=args.wait, dry_run=args.dry_run,
    )
    return 0 if cid else 1


if __name__ == "__main__":
    sys.exit(main())
