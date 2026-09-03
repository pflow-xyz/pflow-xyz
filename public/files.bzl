"""The files served to the browser from //public.

Named once here because two packages need the same list and must not drift:
//public globs them into :public_files, and //internal/static copies them
in-graph into its embed tree (internal/static/public/** is a Makefile
artifact on disk and gitignored, so Bazel must produce it rather than glob
whatever the last `make build` happened to leave behind).
"""

PUBLIC_FILES = [
    "android-chrome-192x192.png",
    "apple-touch-icon.png",
    "banner.png",
    "browserconfig.xml",
    "diagram-viewer.js",
    "diagram-viewer_test.ts",
    "favicon-16x16.png",
    "favicon-32x32.png",
    "favicon.ico",
    "flower-bar.svg",
    "index.html",
    "knapsack-test.json",
    "llms-full.txt",
    "llms.txt",
    "mstile-150x150.png",
    "p-flower.mp4",
    "p-flower.webm",
    "petri-colors.js",
    "petri-colors_test.ts",
    "petri-learn.js",
    "petri-learn_test.ts",
    "petri-sim.js",
    "petri-sim_test.ts",
    "petri-solver.js",
    "petri-ssa.js",
    "petri-ssa_test.ts",
    "petri-view.css",
    "petri-view.js",
    "repo-metadata.json",
    "robots.txt",
    "safari-pinned-tab.svg",
    "schema",
    "seal-cid.mjs",
    "sealed.json",
    "site.webmanifest",
    "test-solver.html",
    "title.svg",
    "vendor/jsonld.bundle.mjs",
]
