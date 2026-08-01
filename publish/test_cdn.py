#!/usr/bin/env python3
"""Tests for publish/cdn.py. Run: python3 publish/test_cdn.py

Uses a temp blobs dir and disables the reload ping / mirror push, so nothing
touches the real CDN tree.
"""

import json
import os
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

from publish import cdn  # noqa: E402

HTML = b"<!doctype html><title>Predator &amp; Prey \xe2\x80\x94 cdn.stackdump.com</title><p>hi"
MODEL = json.dumps({
    "@context": "https://pflow.xyz/schema",
    "@type": "PetriNet",
    "name": "coffee shop",
    "places": {}, "transitions": {}, "arcs": [],
}).encode()


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = pathlib.Path(self.tmp.name)
        self.blobs = root / "blobs"
        self.blobs.mkdir()
        self.src = root / "src"
        self.src.mkdir()
        os.environ["CDN_BLOBS_DIR"] = str(self.blobs)
        os.environ["CDN_PUBLISH_ENABLED"] = "1"
        os.environ["CDN_MIRROR_PUSH"] = ""            # no rsync
        os.environ["CDN_RELOAD_URL"] = "http://127.0.0.1:1/reload"  # refused, non-fatal

    def tearDown(self):
        self.tmp.cleanup()
        for k in ("CDN_BLOBS_DIR", "CDN_PUBLISH_ENABLED", "CDN_MIRROR_PUSH", "CDN_RELOAD_URL"):
            os.environ.pop(k, None)

    def frontmatter(self, cid):
        text = (self.blobs / cid / "index.md").read_text()
        self.assertTrue(text.startswith("---\n"))
        return text.split("---\n")[1], text


class TestCID(Base):
    def test_house_format_and_determinism(self):
        cid = cdn.compute_cid(HTML)
        self.assertRegex(cid, r"^bafyrei[0-9a-f]{32}$")
        self.assertEqual(cid, cdn.compute_cid(HTML))
        self.assertNotEqual(cid, cdn.compute_cid(HTML + b" "))

    def test_cid_tracks_primary_bytes_only(self):
        """Adding a sibling asset must not change the address."""
        (self.src / "demo.html").write_bytes(HTML)
        first = cdn.publish(self.src)
        (self.src / "notes.txt").write_text("side car")
        second = cdn.publish(self.src)
        self.assertEqual(first, second)
        self.assertTrue((self.blobs / second / "notes.txt").exists())


class TestReservedName(Base):
    def test_index_html_is_renamed(self):
        (self.src / "index.html").write_bytes(HTML)
        cid = cdn.publish(self.src)
        staged = self.blobs / cid
        self.assertTrue((staged / "demo.html").exists(), "index.html must be renamed")
        self.assertFalse((staged / "index.html").exists(),
                         "index.html is unreachable behind the landing-page route")
        fm, text = self.frontmatter(cid)
        self.assertIn("path: demo.html", fm)
        self.assertIn("(demo.html)", text, "landing page should link the demo")


class TestInference(Base):
    def test_title_and_schema_from_html(self):
        (self.src / "demo.html").write_bytes(HTML)
        cid = cdn.publish(self.src)
        fm, _ = self.frontmatter(cid)
        self.assertIn("schema: InteractiveDemo/v1", fm)
        self.assertIn("Predator & Prey", fm)
        self.assertNotIn("&amp;", fm, "HTML entities must be decoded in the title")
        self.assertNotIn("cdn.stackdump.com", fm.split("\n")[0],
                         "site suffix should be stripped from the title")

    def test_petri_net_model(self):
        (self.src / "model.jsonld").write_bytes(MODEL)
        cid = cdn.publish(self.src)
        fm, _ = self.frontmatter(cid)
        self.assertIn("schema: PetriNet/v1", fm)
        self.assertIn("coffee shop", fm)

    def test_explicit_values_win(self):
        (self.src / "demo.html").write_bytes(HTML)
        cid = cdn.publish(self.src, title="Chosen", schema="Custom/v2")
        fm, _ = self.frontmatter(cid)
        self.assertIn("title: Chosen", fm)
        self.assertIn("schema: Custom/v2", fm)


class TestFrontmatter(Base):
    def test_required_fields_and_facets(self):
        (self.src / "demo.html").write_bytes(HTML)
        cid = cdn.publish(self.src, tags=["ode", "demo"],
                          meta={"solver": "tsit5", "places": "2", "ratio": "0.5"},
                          parents=["bafyreiparent"])
        fm, _ = self.frontmatter(cid)
        self.assertIn(f"cid: {cid}", fm)
        self.assertIn("source: pflow-xyz", fm)
        self.assertIn("draft: false", fm)
        self.assertIn("  - ode", fm)
        self.assertIn("  - bafyreiparent", fm)
        # numeric-looking meta stays unquoted so range queries work
        self.assertIn("places: 2", fm)
        self.assertIn("ratio: 0.5", fm)
        self.assertIn("solver: tsit5", fm)

    def test_draft_flag(self):
        (self.src / "demo.html").write_bytes(HTML)
        cid = cdn.publish(self.src, draft=True)
        fm, _ = self.frontmatter(cid)
        self.assertIn("draft: true", fm)

    def test_source_index_md_becomes_body(self):
        (self.src / "demo.html").write_bytes(HTML)
        (self.src / "index.md").write_text("---\ntitle: ignored\n---\n\nHand-written prose.\n")
        cid = cdn.publish(self.src)
        _, text = self.frontmatter(cid)
        self.assertIn("Hand-written prose.", text)
        self.assertNotIn("title: ignored", text, "source frontmatter must not leak through")


class TestStaging(Base):
    def test_republish_replaces_cleanly(self):
        (self.src / "demo.html").write_bytes(HTML)
        (self.src / "stale.txt").write_text("old")
        cid = cdn.publish(self.src)
        self.assertTrue((self.blobs / cid / "stale.txt").exists())
        (self.src / "stale.txt").unlink()
        cid2 = cdn.publish(self.src)
        self.assertEqual(cid, cid2)
        self.assertFalse((self.blobs / cid / "stale.txt").exists(),
                         "republish should not leave removed files behind")

    def test_no_staging_dirs_left(self):
        (self.src / "demo.html").write_bytes(HTML)
        cdn.publish(self.src)
        leftovers = [p.name for p in self.blobs.iterdir() if p.name.startswith(".staging")]
        self.assertEqual(leftovers, [])

    def test_subdirectories_preserved(self):
        (self.src / "demo.html").write_bytes(HTML)
        (self.src / "assets").mkdir()
        (self.src / "assets" / "plot.svg").write_text("<svg/>")
        cid = cdn.publish(self.src)
        self.assertTrue((self.blobs / cid / "assets" / "plot.svg").exists())

    def test_dry_run_writes_nothing(self):
        (self.src / "demo.html").write_bytes(HTML)
        cid = cdn.publish(self.src, dry_run=True)
        self.assertIsNotNone(cid)
        self.assertFalse((self.blobs / cid).exists())

    def test_missing_source_returns_none(self):
        self.assertIsNone(cdn.publish(self.src / "nope.html"))


class TestCLI(Base):
    def test_exit_codes(self):
        (self.src / "demo.html").write_bytes(HTML)
        self.assertEqual(cdn.main([str(self.src), "--tag", "x"]), 0)
        self.assertEqual(cdn.main([str(self.src / "missing.html")]), 1)
        self.assertEqual(cdn.main([str(self.src), "--meta", "bad"]), 2)


if __name__ == "__main__":
    # buffer=True: the publisher's progress prints are noise unless a test fails
    unittest.main(verbosity=2, buffer=True)
