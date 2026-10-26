# parity/clipboard — the shared clipboard fixture

`clip-v1.json` is the fixture of the pflow clipboard format
(`docs/clipboard-format.md`): the text pflow.xyz and pflow-native put on the
system clipboard on Copy/Cut and read back on Paste. The spec has pflow-native
carry a byte-identical copy and run the same checks against it. Never edit
either file here; a change to the format is made in both repos at once, and
the hashes below refreshed together.

`public/petri-clipboard_test.ts` (in `make test-js` and CI) checks the
fixture's sha256, parses it, pastes it into an empty net (2 places, 1
transition at rate 2.5, 2 arcs, fresh ids), and checks that this editor's
Copy of the pasted selection parses back to the same nodes and arcs. It also
checks that `clipToText` writes the fixture's own clip back byte for byte.

| file | sha256 |
|---|---|
| clip-v1.json | ba8ff2db4b2dca16baa83bbe9c35145ea99e0887d4512a68e8b1a0ef5d146276 |
| ../../docs/clipboard-format.md | a15f499b74dbb8b9d583829f2c18a14466d320e7a304d65c0b41de55595735a6 |
