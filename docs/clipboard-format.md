# pflow clipboard format, version 1

Shared by pflow-native (crates/app + edit.copy/cut/paste) and pflow.xyz
(public/petri-clipboard.js + petri-view.js) so nodes copied in one paste in
the other, through the operating system clipboard.

- Carrier: the system clipboard as UTF-8 plain text (`text/plain`). Plain text
  is the one flavor both egui (copy_text / Event::Paste) and browsers
  (ClipboardEvent.clipboardData, navigator.clipboard) read and write without
  extra permissions. A writer may add more flavors; a reader needs only text.
- Payload: one JSON object that is a pflow JSON-LD PetriNet document
  (`"@context": "https://pflow.xyz/schema"`, `"@type": "PetriNet"`,
  `"@version": "1.1"`, `token`, `places`, `transitions`, `arcs`), holding only
  the copied places and transitions, plus every arc whose two ends were both
  copied. Ids, labels, coordinates, `initial`, `capacity`, `offset`, arc
  `weight` and `inhibitTransition` are copied as they are. A transition carries
  its `rate` when the source net has one (native reads it from Session.rates).
  No `@id` (a clip is not sealed).
- Marker: one extra top-level member
  `"pflowClip": {"version": 1, "origin": "pflow-native" | "pflow.xyz"}`.
- Writers emit it on Copy and Cut. They keep their in-app clipboard too, so
  copy and paste inside one app still works if the system clipboard is
  unavailable or denied.
- Readers, on Paste: if the clipboard text parses as JSON with
  `pflowClip.version == 1`, paste it. If it is a plain pflow PetriNet document
  with no `pflowClip`, paste the whole net as if it were a clip. If
  `pflowClip.version` is greater than 1, refuse with a status message. Any
  other text: fall back to the in-app clipboard (or do nothing).
- Paste semantics stay as both apps have them today: fresh first-free ids
  (p{n}/t{n}), original coordinates plus (+40, +40), arcs remapped, pasted
  nodes become the selection, one undo step. Native moves pasted rates into
  Session.rates as it does on load; the web keeps them on the transition.
- Token colors: paste never changes the target net's `token` list. Each pasted
  place's `initial` and `capacity` and each pasted arc's `weight` is cut or
  padded with 0 to the target's color count (its `token` list's length, at
  least 1), so colors map by position: the clip's first color becomes the
  target's first, and so on. An arc with no `weight` counts as `[1]` first.
  Padding gives no tokens, an unbounded capacity and "this color is not
  involved"; cutting drops the clip's extra colors, tokens included. A reader
  may say so in a status message when the two `token` lists differ.
- Shared fixture: `clip-v1.json`, byte-identical in both repos
  (sha256 ba8ff2db4b2dca16baa83bbe9c35145ea99e0887d4512a68e8b1a0ef5d146276).
  Each repo's tests parse it, paste it into an empty net (expect 2 places,
  1 transition with rate 2.5, 2 arcs, ids fresh), and check that its own Copy
  output of that pasted selection parses back to the same nodes and arcs.
