# The pflow notation: a text for Petri nets

Status: a design with a working prototype, on branch `design/pflow-notation`. **Nothing here changes the product**: no served code imports `internal/notation`, no route serves the notation, and the sealing contract, the JSON-LD context and the core theory are untouched. Written 2026-11-23.

What is in the change:

| | where | licence |
|---|---|---|
| this document | `docs/pflow-notation.md` | MIT (the repository's) |
| the grammar, the one source of truth | [`docs/notation/pflow.ebnf`](notation/pflow.ebnf) | CC0 |
| six examples, each beside the JSON-LD it compiles to, and their CIDs | [`docs/notation/examples/`](notation/examples/) | CC0 |
| the grammar drawn as railroad diagrams by BeatScript's own renderer | [`docs/notation/railroad.html`](notation/railroad.html) | generated, CC0 |
| a Go prototype of the core subset and its tests | `internal/notation/` | MIT |

Run it: `go test ./internal/notation` (the grammar both ways, every example to its CID, the advisor, the round trips) and `go run ./internal/notation/cmd/pflowtext check -advise 2000 docs/notation/examples/readers-writers.pnet`.

The calls that are the maintainer's, in the order they cost to change (all of §7 has the reasons): **(1)** the text is a way to write the document and is never what is hashed, so layout is identity; **(2)** `.pnet`, not `.pflow`, which the S-expression token-model DSL already owns; **(3)** weights on the place (`beans*2 brown`), `-o` for inhibitor and `<->` for read; **(4)** the reference implementation in `pflow-native` with Go as the executable spec, not the other way round; **(5)** shared code in a new zero-dependency `langkit` repo, `ebnf` and `railroad` first, because they already work unmodified.

## Contents

0. [The idea](#0-the-idea)
1. [Syntax](#1-syntax)
2. [The grammar](#2-the-grammar)
3. [Round trips](#3-round-trips)
4. [The advisor](#4-the-advisor)
5. [Tooling reuse](#5-tooling-reuse)
6. [The prototype](#6-the-prototype)
7. [Taste calls](#7-taste-calls)
8. [Findings in code that already exists](#8-findings-in-code-that-already-exists)
9. [Neighbouring notations](#9-neighbouring-notations)

## 0. The idea

BeatScript went from the model to a language: a track is a set of nets, and BeatScript is the text that writes them, with an editor that colours it, puts every mistake on the line that made it, and answers `check` and `listen` as you type. The net and the text are two faces of one thing. pflow has the model already, an editor-shaped JSON-LD document that every saved net is addressed by. This document is the other face: **a text that compiles to that document, and prints back from it.**

What the BeatScript editor has, and what the pflow editor would get:

| BeatScript editor | pflow today | with the notation |
|---|---|---|
| colours the text by token class (`highlight.rs`) | none: nets are drawn, JSON is edited as JSON | a highlighter generated from the grammar's classes |
| a parse error with line and column, the line after it still read | `Check net` chip: `{path, message}` over a JSON path (`places.slots.initial`) | a diagnostic on the line that wrote it, with what was expected |
| `check`: names, ranges, what is inaudible | `Check net` again: ids, vectors, capacities | the same rules, anchored to the text |
| `listen`: loudness, what is heard | `verify`, `validate`, `reachability`: three tools, a result card | the verdicts as line annotations: laws on the places they are about, a deadlock on the net, a dead transition on its own line |

One difference decides most of the design, so it comes first. **In BeatScript the CID is of the canonical text** (`{"format":2,"text":<canonical text>,"type":"beatscript"}`). **In pflow the CID is of the JSON-LD document** (URDNA2015 over the document minus its `@id`, sha-256, CIDv1 dag-json: `internal/seal`, `public/seal-cid.mjs`, `crates/core/src/cid.rs`), and every net ever saved is named that way. The notation cannot be the thing that is hashed. It is a way to write the document, and *the text and the document mean the same net when they seal to the same CID.* §3 is the consequence.

The model the text denotes is the editor's JSON-LD, called Shape A in [`docs/model-identity.md`](model-identity.md), not go-pflow's metamodel shape. Shape A is the wire and identity format; the metamodel is what engines read and `parser.ModelFromJSON` derives from it (colours unfold, an output-side inhibitor becomes a read arc). A text that denoted the metamodel could not reproduce a CID.

## 1. Syntax

### 1.1 A net in a dozen lines

<!-- example:bounded-buffer -->
<table>
<tr><th align="left">notation: <code>bounded-buffer.pnet</code></th><th align="left">JSON-LD: <code>bounded-buffer.jsonld</code></th></tr>
<tr><td valign="top">

```pflow
#! pflow 1
net "Bounded buffer"
about "A producer fills three slots and a consumer empties them. slots + items is always 3."
color black

# positions are what the editor's own layout pass (petri-layout.js, auto) gives the draft with none
place slots = 3 cap 3 @ 100, 100
place items cap 3 @ 100, 183

transition produce @ 365, 113
transition consume @ 365, 170

# a chain is the arcs between neighbours, in order
slots -> produce -> items
items -> consume -> slots
```

</td><td valign="top">

<details open><summary>68 lines</summary>

```json
{
  "@context": "https://pflow.xyz/schema",
  "@type": "PetriNet",
  "@version": "1.1",
  "arcs": [
    {
      "@type": "Arrow",
      "inhibitTransition": false,
      "source": "slots",
      "target": "produce",
      "weight": [1]
    },
    {
      "@type": "Arrow",
      "inhibitTransition": false,
      "source": "produce",
      "target": "items",
      "weight": [1]
    },
    {
      "@type": "Arrow",
      "inhibitTransition": false,
      "source": "items",
      "target": "consume",
      "weight": [1]
    },
    {
      "@type": "Arrow",
      "inhibitTransition": false,
      "source": "consume",
      "target": "slots",
      "weight": [1]
    }
  ],
  "description": "A producer fills three slots and a consumer empties them. slots + items is always 3.",
  "name": "Bounded buffer",
  "places": {
    "slots": {
      "@type": "Place",
      "capacity": [3],
      "initial": [3],
      "offset": 0,
      "x": 100,
      "y": 100
    },
    "items": {
      "@type": "Place",
      "capacity": [3],
      "initial": [0],
      "offset": 0,
      "x": 100,
      "y": 183
    }
  },
  "token": ["https://pflow.xyz/tokens/black"],
  "transitions": {
    "produce": {
      "@type": "Transition",
      "x": 365,
      "y": 113
    },
    "consume": {
      "@type": "Transition",
      "x": 365,
      "y": 170
    }
  }
}
```

</details>

</td></tr>
</table>
<!-- /example:bounded-buffer -->

`#! pflow 1` names the notation's version (it is not part of the document; it selects `@version: "1.1"` and the editor's profile, §3.4). `color black` is the token colour. `place slots = 3 cap 3` is a place holding 3 and holding at most 3. A chain, `slots -> produce -> items`, is the arcs between neighbours, in order. The positions after `@` are the editor's own `auto` layout of the draft that had none; layout is part of the document, so part of its CID (§3.6). Its CID is `z4EBG9jH9s6PYwJmBooUjcs85bYCBFfaCfhBDjaTZ8nk41ZBExS`.

### 1.2 What the text says, and which JSON-LD key it becomes

| text | JSON-LD | notes |
|---|---|---|
| `#! pflow 1` | nothing | the first line; the notation's version, not the model's |
| `net Kind "name"` | `@type`, `name` | `Kind` defaults to `PetriNet`; the name is a string |
| `about "text"` | `description` | on `net`, `place` and `transition` |
| `color a, b, c` | `token: [".../tokens/a", …]` | the order is the order of every vector; `x = <https://…>` names another token IRI |
| `parents z…, z…` | `parents` | an ordered list, newest first: part of the CID |
| `place p = M cap C label "L" about "D" @ x, y` | `places.p` | `initial`, `capacity`, `label`, `description`, `x`, `y`; `offset: 0` is written for you |
| `transition t rate r label "L" role R offset N @ x, y` | `transitions.t` | `rate` is the engines' mass-action rate |
| `a*w -> t`, `t -> b*w` | an arc, `inhibitTransition: false` | consume and produce, by the direction |
| `p*w -o t` | an arc `p → t`, `inhibitTransition: true` | the inhibitor |
| `p*w <-> t` | an arc **`t → p`**, `inhibitTransition: true` | the editor's read arc: written as a transition-to-place arc with the flag (`parser.ModelFromJSON`: "an output-side one is the editor's read arc") |
| `# …` | nothing | trivia: it cannot change a CID |

Everything the document holds that the table does not name is `ext` in the grammar and "not carried" in the prototype (§1.10).

### 1.3 Lexical conventions

- **One statement to a line.** A line is `[ statement ] NEWLINE`; there is no continuation and no indentation rule. This is BeatScript's shape (`line = [ statement ] NEWLINE`), and it is what makes error recovery free: a line that does not parse is reported and skipped, and the lines around it are read as if it were not there (§4.3).
- **Comments** run from `#` to the end of the line, except `#!` at the start of a line, which is the pragma.
- **Names** are `[A-Za-z_][A-Za-z0-9_]*`. The words that start a statement or an attribute are reserved (`net about color parents place transition cap label offset rate role ext compose part port link`); a reserved word, or an id with odd characters, is quoted: `place "cap"`. The other words the grammar spells (`in`, `out`, `null`, `sum`, `event` …) are read as words only where the grammar expects them, so `in -> work -> out` is an arc.
- **Strings** are JSON strings; **numbers** are JSON numbers (`0.001`, `720`).
- **Order is meaning** in exactly the places the sealer makes it so: arcs and `token` and `parents` are lists, so the text's order of arcs is the document's (§3.3). Places and transitions are sets to the sealer, and the text keeps the order they are declared in.

### 1.4 Places and transitions

```pflow
place WaitingCustomers = 2 red cap 10 red label "Waiting Customers" @ 200, 150
transition BrewCoffee rate 0.25 label "Brew Coffee" @ 350, 300
```

- A **marking** (`= …`) and a **capacity** (`cap …`) are *sums*, `2 red + 1 blue`, or a *list*, `[2, 1]`. A sum fills a zero for every colour it does not name; in a net with at most one colour it is just a number: `= 3`. A list is the vector as the document holds it, and is how the odd shapes the editor has written (`[]`, `[null]`) are said (§3.3).
- **Nothing said** is the editor's default: no `=` is a marking of zeros; no `cap` is unbounded, written the way the editor writes it (`[null]`, which seals as `[]`).
- `cap` of `0` on a colour means unbounded, as the engines read it (`capacityOf`: "capacity=0 is treated as unbounded"). The check tier does not call that wrong.
- `label` is the name the editor draws (a single line of at most 100 characters: `labelProblem`); `about` is the description; `offset` and `role` are carried because real nets hold them (`knapsack` does).
- `@ x, y` is where the editor draws it. Optional, and §3.6 says what leaving it out costs.

### 1.5 Arcs

```pflow
WaitingCustomers*1 red -> BrewCoffee      # consume 1 red from the place
BrewCoffee -> ServedCoffee*1 red          # produce
writing -o start_read                     # inhibitor: start_read waits until writing is empty
online <-> start_write                    # read: start_write needs the token and leaves it
reading, writing -o shutdown              # a group: one arc from each
readers -> start_read -> reading          # a chain: readers → start_read, start_read → reading
```

- **The weight is written on the place** (`beans*2 brown`), because an arc always has exactly one place end. The checker says so if it is on the transition.
- A **weight** is a sum or a list like a marking. In a net with more than one colour a bare end is an error: `p -> t` does not say which colour moves. (The editor writes `[1, 0, 0]`; the text writes `p*1 red`.)
- **Chains and groups** are sugar for the arcs they pair up, left to right and in text order: `a, b -> t -> c` is `a→t`, `b→t`, `t→c`. The canonical print writes one arc to a line. The parser accepts both; the order of the arcs is the order of the document's `arcs` list, which is part of the CID.
- `->` consumes or produces, by direction. **`-o`** is the inhibitor: the transition is blocked while the place holds at least the weight on any colour the weight names (`enabled` in `petri-sim.js`). **`<->`** is the read arc: the place must hold the weight, nothing moves, and the arc does not appear in the incidence matrix.
- A glyph needs a place on its left and a transition on its right (`->` takes either direction). The checker reports the wrong shape on the arrow.

### 1.6 Colours, and types

pflow has **colours** and no other types. A colour is one component of every vector in the net: `token` lists the colour IRIs, `initial`, `capacity` and `weight` are vectors with a component for each, and the engines unfold a coloured net to one place per colour (`ExpandColors`). The text names the components so nobody counts commas:

```pflow
color red, brown, blue
place CoffeeBeans = 5 brown cap 10 brown
RestockBeans -> CoffeeBeans*3 brown       # [0, 3, 0]
```

`color prey = <https://pflow.xyz/tokens/blue>` names a colour for readability and keeps the IRI the editor draws it by. `lotka-volterra` below uses the plain names (`blue`, `red`).

There are no *data* types in Shape A. Places that hold maps and integers, guards and key/value arcs live in the S-expression token-model DSL (`.pflow`, `tokenmodel/dsl`, §9), and kinetic switches, schedules and stages live in the metamodel shape. Neither is in the editor's document, so neither is in notation version 1. The grammar reserves `ext` for whatever comes later.

### 1.7 Rates

`transition t rate 0.25` is the `rate` term (`https://pflow.xyz/schema#rate` under the context's `@vocab`) that `petri-sim.js` `rateOf`, go-pflow's ODE and SSA engines and pflow-rs read. A net with no rates seals to the same CID it always did, and so does its text.

### 1.8 Labels

`label "Waiting Customers"` is display text and never an id: an id is what arcs name. The checker applies the editor's label rule (non-empty, one line, at most 100 characters).

### 1.9 Composition

pflow's composition is a `PetriNetBundle` (`go-pflow/metamodel/compose.go`; the page is `compose.html`): independently authored nets with a boundary, joined by typed links, flattened to one net every analysis reads. The notation writes that **as a netlist**, because the document is one:

```pflow
compose "Two buffers in series" namespace arc_merge sum
part first  ResourceNet = z4EBG9jH9s6PYwJmBooUjcs85bYCBFfaCfhBDjaTZ8nk41ZBExS       # a subnet: the CID of a stored net, or a name in this file
part second ResourceNet = z4EBG9jH9s6PYwJmBooUjcs85bYCBFfaCfhBDjaTZ8nk41ZBExS
port pantry.beans observe place beans    # a point on a part's boundary and which way it faces
link handoff event first.consume ~ second.produce
link beans_low guard counter.start ~ port pantry.beans when ">= 2" lowering auto
```

| the compose page's vocabulary | the Bundle | the text |
|---|---|---|
| a box, a net with a boundary | `subnets[]` `{@type, id, net_type, cid}` | `part first ResourceNet = <cid>` |
| a point on the boundary | `subnet.ports[]` `{id, kind, target, place \| transition}` | `port pantry.beans observe place beans` |
| a wire that glues two boxes | `links[]` `{id, kind, from, to, condition, lowering}` | `link id kind a.x ~ b.y [when "…"] [lowering …]` |
| the wire's type | `kind`: `token`, `data`, `event`, `guard` | place fusion, read-only place fusion, transition fusion, a gate that lowers to an inhibitor arc or a guard |
| the composite | what `Flatten` returns | nothing: it is derived, never written |

- A part is **by reference** (`cid`), as [`docs/model-identity.md`](model-identity.md) requires: a composition names stored nets. The text may name a net in the same file instead and the compiler writes its CID; that is why a file with a `compose` may hold several `net` blocks (the prototype reads one).
- The composition's CID is the seal of the document as written; a part keeps its own. Changing a link changes only the composition's CID; editing a part is a new net, so a new part CID, so a new composition CID. That makes pinned CIDs in a text brittle, and it is the reason to prefer names in a file (a lock file, like `pflow-js.lock`, is the other way).
- `link … ~ …` ends are `part.element`; the element is a transition, a place or a port, and a prefix (`port`, `place`, `transition`) says which when the link kind does not. The legality of a link is go-pflow's (`compose_matrix.go`), and the advisor's check tier asks it, never re-implements it.
- `pipeline.pnet` below is this, written out by hand: the prototype's parser does not read `compose`, but the grammar recogniser does, and a test runs the document through `internal/model` (identity, structure, `Flatten`).

### 1.10 What the text does not say

- **`ext`**, in the grammar and not in the prototype: `ext place buffer "key" = {json}` keeps any key the notation has no word for, as JSON, so any document can be carried. Without it the printer lists what it could not carry and the CID comparison catches the rest (§3.2).
- **`author`**: the most common key the core lacks (§3.2). It is provenance the server stamps at save, from the signed-in session. The notation leaves it to the save path; `ext author = {…}` carries a stored net's, for fidelity.
- **Assertions and notes.** "These two places are never both marked" is a claim about a net, not part of it, and [`docs/model-identity.md`](model-identity.md) already says judgment text lives beside the model, never in it, because everything in a sealed document is hashed. pflow-native's `ModelContent` is that sidecar (`finding`, `caveat`, `scenario` with `expect` rows, keyed by element ids, `content.check`). The recommendation: an `expect` or `note` statement in the same file that compiles to the second document, one file and several documents as `compose` does. Not in the grammar yet.

### 1.11 The examples

Six programs, each with the JSON-LD it compiles to. Two are nets that already existed (`coffee-shop`, `knapsack`: pflow.xyz's own parity fixtures, held to the CIDs in `parity/golden.json`); three are new; one is a composition. All six are CC0.

#### coffee-shop: colours, rates, labels, layout (a known pflow.xyz net)

`parity/fixtures/with-rates.jsonld`, the coffee shop with rates. The text is what the printer writes for it; compiling the text gives back the document's own CID, `z4EBG9jA7f4q9yx4QjzH3RDPQXiqjnNTz3ALdpjHD3CRTbNrcCD`, the one `parity/golden.json` records for the fixture.

<!-- example:coffee-shop -->
<table>
<tr><th align="left">notation: <code>coffee-shop.pnet</code></th><th align="left">JSON-LD: <code>coffee-shop.jsonld</code></th></tr>
<tr><td valign="top">

```pflow
#! pflow 1
net "coffee shop (with rates)"
color red, brown, blue

place WaitingCustomers = 2 red cap 10 red label "Waiting Customers" @ 200, 150
place CoffeeBeans = 5 brown cap 10 brown label "Coffee Beans" @ 200, 300
place EmptyCups = 5 blue cap 10 blue label "Empty Cups" @ 200, 450
place ServedCoffee cap 5 red label "Served Coffee" @ 500, 300

transition CustomerArrives rate 2 label "Customer Arrives" @ 50, 150
transition BrewCoffee rate 0.25 label "Brew Coffee" @ 350, 300
transition CustomerLeaves rate 0.001 label "Customer Leaves" @ 650, 300
transition RestockBeans rate 720 label "Restock Beans" @ 50, 300
transition RestockCups rate 0 label "Restock Cups" @ 50, 450

WaitingCustomers*1 red -> BrewCoffee
CoffeeBeans*1 brown -> BrewCoffee
EmptyCups*1 blue -> BrewCoffee
BrewCoffee -> ServedCoffee*1 red
ServedCoffee*1 red -> CustomerLeaves
CustomerArrives -> WaitingCustomers*1 red
RestockBeans -> CoffeeBeans*3 brown
RestockCups -> EmptyCups*3 blue
```

</td><td valign="top">

<details><summary>140 lines</summary>

```json
{
  "@context": "https://pflow.xyz/schema",
  "@type": "PetriNet",
  "@version": "1.1",
  "arcs": [
    {
      "@type": "Arrow",
      "inhibitTransition": false,
      "source": "WaitingCustomers",
      "target": "BrewCoffee",
      "weight": [1, 0, 0]
    },
    {
      "@type": "Arrow",
      "inhibitTransition": false,
      "source": "CoffeeBeans",
      "target": "BrewCoffee",
      "weight": [0, 1, 0]
    },
    {
      "@type": "Arrow",
      "inhibitTransition": false,
      "source": "EmptyCups",
      "target": "BrewCoffee",
      "weight": [0, 0, 1]
    },
    {
      "@type": "Arrow",
      "inhibitTransition": false,
      "source": "BrewCoffee",
      "target": "ServedCoffee",
      "weight": [1, 0, 0]
    },
    {
      "@type": "Arrow",
      "inhibitTransition": false,
      "source": "ServedCoffee",
      "target": "CustomerLeaves",
      "weight": [1, 0, 0]
    },
    {
      "@type": "Arrow",
      "inhibitTransition": false,
      "source": "CustomerArrives",
      "target": "WaitingCustomers",
      "weight": [1, 0, 0]
    },
    {
      "@type": "Arrow",
      "inhibitTransition": false,
      "source": "RestockBeans",
      "target": "CoffeeBeans",
      "weight": [0, 3, 0]
    },
    {
      "@type": "Arrow",
      "inhibitTransition": false,
      "source": "RestockCups",
      "target": "EmptyCups",
      "weight": [0, 0, 3]
    }
  ],
  "name": "coffee shop (with rates)",
  "places": {
    "WaitingCustomers": {
      "@type": "Place",
      "capacity": [10, 0, 0],
      "initial": [2, 0, 0],
      "label": "Waiting Customers",
      "offset": 0,
      "x": 200,
      "y": 150
    },
    "CoffeeBeans": {
      "@type": "Place",
      "capacity": [0, 10, 0],
      "initial": [0, 5, 0],
      "label": "Coffee Beans",
      "offset": 0,
      "x": 200,
      "y": 300
    },
    "EmptyCups": {
      "@type": "Place",
      "capacity": [0, 0, 10],
      "initial": [0, 0, 5],
      "label": "Empty Cups",
      "offset": 0,
      "x": 200,
      "y": 450
    },
    "ServedCoffee": {
      "@type": "Place",
      "capacity": [5, 0, 0],
      "initial": [0, 0, 0],
      "label": "Served Coffee",
      "offset": 0,
      "x": 500,
      "y": 300
    }
  },
  "token": ["https://pflow.xyz/tokens/red", "https://pflow.xyz/tokens/brown", "https://pflow.xyz/tokens/blue"],
  "transitions": {
    "CustomerArrives": {
      "@type": "Transition",
      "label": "Customer Arrives",
      "rate": 2,
      "x": 50,
      "y": 150
    },
    "BrewCoffee": {
      "@type": "Transition",
      "label": "Brew Coffee",
      "rate": 0.25,
      "x": 350,
      "y": 300
    },
    "CustomerLeaves": {
      "@type": "Transition",
      "label": "Customer Leaves",
      "rate": 0.001,
      "x": 650,
      "y": 300
    },
    "RestockBeans": {
      "@type": "Transition",
      "label": "Restock Beans",
      "rate": 720,
      "x": 50,
      "y": 300
    },
    "RestockCups": {
      "@type": "Transition",
      "label": "Restock Cups",
      "rate": 0,
      "x": 50,
      "y": 450
    }
  }
}
```

</details>

</td></tr>
</table>
<!-- /example:coffee-shop -->

#### knapsack: the shape the editor really writes (a known pflow.xyz net)

`parity/fixtures/knapsack.jsonld`, from the game-search work. It is here because it is *not tidy*: `token` is empty, two places have `initial: []` and `capacity: []`, the rest `capacity: [null]`, and every transition carries `offset: 0` and `role: "default"`. The text carries all of it (`= []`, `role default offset 0`) and seals to `z4EBG9jAJRwz8xUfq4ELvGPvUNfD13DqHERooMvJaqkb8bUHKaQ`, the golden. It is also the example the advisor argues with (§4.5): it ends in a dead marking on purpose.

<!-- example:knapsack -->
<table>
<tr><th align="left">notation: <code>knapsack.pnet</code></th><th align="left">JSON-LD: <code>knapsack.jsonld</code></th></tr>
<tr><td valign="top">

```pflow
#! pflow 1
net

place capacity = 15 @ 730, 541
place item0 = 1 @ 351, 140
place item1 = 1 @ 353, 265
place item2 = 1 @ 351, 417
place item3 = 1 @ 350, 543
place value = [] @ 765, 145
place weight = [] @ 880, 320

transition txn0 role default offset 0 @ 465, 139
transition txn1 role default offset 0 @ 466, 264
transition txn2 role default offset 0 @ 462, 418
transition txn3 role default offset 0 @ 464, 542

txn0 -> weight*2
txn0 -> value*10
txn1 -> weight*4
item0 -> txn0
txn1 -> value*10
item1 -> txn1
item2 -> txn2
item3 -> txn3
txn2 -> weight*6
txn2 -> value*12
txn3 -> value*18
txn3 -> weight*9
capacity*2 -> txn0
capacity*4 -> txn1
capacity*6 -> txn2
capacity*9 -> txn3
```

</td><td valign="top">

<details><summary>208 lines</summary>

```json
{
  "@context": "https://pflow.xyz/schema",
  "@type": "PetriNet",
  "@version": "1.1",
  "arcs": [
    {
      "@type": "Arrow",
      "inhibitTransition": false,
      "source": "txn0",
      "target": "weight",
      "weight": [2]
    },
    {
      "@type": "Arrow",
      "inhibitTransition": false,
      "source": "txn0",
      "target": "value",
      "weight": [10]
    },
    {
      "@type": "Arrow",
      "inhibitTransition": false,
      "source": "txn1",
      "target": "weight",
      "weight": [4]
    },
    {
      "@type": "Arrow",
      "inhibitTransition": false,
      "source": "item0",
      "target": "txn0",
      "weight": [1]
    },
    {
      "@type": "Arrow",
      "inhibitTransition": false,
      "source": "txn1",
      "target": "value",
      "weight": [10]
    },
    {
      "@type": "Arrow",
      "inhibitTransition": false,
      "source": "item1",
      "target": "txn1",
      "weight": [1]
    },
    {
      "@type": "Arrow",
      "inhibitTransition": false,
      "source": "item2",
      "target": "txn2",
      "weight": [1]
    },
    {
      "@type": "Arrow",
      "inhibitTransition": false,
      "source": "item3",
      "target": "txn3",
      "weight": [1]
    },
    {
      "@type": "Arrow",
      "inhibitTransition": false,
      "source": "txn2",
      "target": "weight",
      "weight": [6]
    },
    {
      "@type": "Arrow",
      "inhibitTransition": false,
      "source": "txn2",
      "target": "value",
      "weight": [12]
    },
    {
      "@type": "Arrow",
      "inhibitTransition": false,
      "source": "txn3",
      "target": "value",
      "weight": [18]
    },
    {
      "@type": "Arrow",
      "inhibitTransition": false,
      "source": "txn3",
      "target": "weight",
      "weight": [9]
    },
    {
      "@type": "Arrow",
      "inhibitTransition": false,
      "source": "capacity",
      "target": "txn0",
      "weight": [2]
    },
    {
      "@type": "Arrow",
      "inhibitTransition": false,
      "source": "capacity",
      "target": "txn1",
      "weight": [4]
    },
    {
      "@type": "Arrow",
      "inhibitTransition": false,
      "source": "capacity",
      "target": "txn2",
      "weight": [6]
    },
    {
      "@type": "Arrow",
      "inhibitTransition": false,
      "source": "capacity",
      "target": "txn3",
      "weight": [9]
    }
  ],
  "places": {
    "capacity": {
      "@type": "Place",
      "capacity": [null],
      "initial": [15],
      "offset": 0,
      "x": 730,
      "y": 541
    },
    "item0": {
      "@type": "Place",
      "capacity": [null],
      "initial": [1],
      "offset": 0,
      "x": 351,
      "y": 140
    },
    "item1": {
      "@type": "Place",
      "capacity": [null],
      "initial": [1],
      "offset": 0,
      "x": 353,
      "y": 265
    },
    "item2": {
      "@type": "Place",
      "capacity": [null],
      "initial": [1],
      "offset": 0,
      "x": 351,
      "y": 417
    },
    "item3": {
      "@type": "Place",
      "capacity": [null],
      "initial": [1],
      "offset": 0,
      "x": 350,
      "y": 543
    },
    "value": {
      "@type": "Place",
      "capacity": [null],
      "initial": [],
      "offset": 0,
      "x": 765,
      "y": 145
    },
    "weight": {
      "@type": "Place",
      "capacity": [null],
      "initial": [],
      "offset": 0,
      "x": 880,
      "y": 320
    }
  },
  "token": [],
  "transitions": {
    "txn0": {
      "@type": "Transition",
      "offset": 0,
      "role": "default",
      "x": 465,
      "y": 139
    },
    "txn1": {
      "@type": "Transition",
      "offset": 0,
      "role": "default",
      "x": 466,
      "y": 264
    },
    "txn2": {
      "@type": "Transition",
      "offset": 0,
      "role": "default",
      "x": 462,
      "y": 418
    },
    "txn3": {
      "@type": "Transition",
      "offset": 0,
      "role": "default",
      "x": 464,
      "y": 542
    }
  }
}
```

</details>

</td></tr>
</table>
<!-- /example:knapsack -->

#### readers-writers: inhibitor arcs and read arcs

Readers share the database and a writer needs it alone; nothing is a lock. `writing -o start_read` says a reader waits while a writer writes, `reading -o start_write` the other way, and `online <-> start_read` says both need the database online without taking the token. CID `z4EBG9j1WfcEzXDy9AahVGnw26SNCYBscDJu7ir3bkbdKkBHF2k`. The advisor proves three conservation laws and finds no deadlock in the five markings.

<!-- example:readers-writers -->
<table>
<tr><th align="left">notation: <code>readers-writers.pnet</code></th><th align="left">JSON-LD: <code>readers-writers.jsonld</code></th></tr>
<tr><td valign="top">

```pflow
#! pflow 1
net "Readers and writers"
about "Readers share the database, a writer needs it alone. -o says 'only while empty', <-> says 'only while there is a token'."

place readers = 2 label "Idle readers" @ 120, 120
place reading label "Reading" @ 360, 120
place writers = 1 label "Idle writers" @ 120, 320
place writing label "Writing" @ 360, 320
place online = 1 @ 600, 220
place offline @ 840, 220

transition start_read @ 240, 120
transition end_read @ 240, 40
transition start_write @ 240, 320
transition end_write @ 240, 400
transition shutdown @ 720, 160
transition restart @ 720, 280

readers -> start_read -> reading -> end_read -> readers
writers -> start_write -> writing -> end_write -> writers

# no reader starts while a writer writes, no writer while anyone reads
writing -o start_read
reading -o start_write

# both need the database online; neither takes the token
online <-> start_read
online <-> start_write

# it can only go offline while nobody is using it
reading, writing -o shutdown
online -> shutdown -> offline -> restart -> online
```

</td><td valign="top">

<details><summary>222 lines</summary>

```json
{
  "@context": "https://pflow.xyz/schema",
  "@type": "PetriNet",
  "@version": "1.1",
  "arcs": [
    {
      "@type": "Arrow",
      "inhibitTransition": false,
      "source": "readers",
      "target": "start_read",
      "weight": [1]
    },
    {
      "@type": "Arrow",
      "inhibitTransition": false,
      "source": "start_read",
      "target": "reading",
      "weight": [1]
    },
    {
      "@type": "Arrow",
      "inhibitTransition": false,
      "source": "reading",
      "target": "end_read",
      "weight": [1]
    },
    {
      "@type": "Arrow",
      "inhibitTransition": false,
      "source": "end_read",
      "target": "readers",
      "weight": [1]
    },
    {
      "@type": "Arrow",
      "inhibitTransition": false,
      "source": "writers",
      "target": "start_write",
      "weight": [1]
    },
    {
      "@type": "Arrow",
      "inhibitTransition": false,
      "source": "start_write",
      "target": "writing",
      "weight": [1]
    },
    {
      "@type": "Arrow",
      "inhibitTransition": false,
      "source": "writing",
      "target": "end_write",
      "weight": [1]
    },
    {
      "@type": "Arrow",
      "inhibitTransition": false,
      "source": "end_write",
      "target": "writers",
      "weight": [1]
    },
    {
      "@type": "Arrow",
      "inhibitTransition": true,
      "source": "writing",
      "target": "start_read",
      "weight": [1]
    },
    {
      "@type": "Arrow",
      "inhibitTransition": true,
      "source": "reading",
      "target": "start_write",
      "weight": [1]
    },
    {
      "@type": "Arrow",
      "inhibitTransition": true,
      "source": "start_read",
      "target": "online",
      "weight": [1]
    },
    {
      "@type": "Arrow",
      "inhibitTransition": true,
      "source": "start_write",
      "target": "online",
      "weight": [1]
    },
    {
      "@type": "Arrow",
      "inhibitTransition": true,
      "source": "reading",
      "target": "shutdown",
      "weight": [1]
    },
    {
      "@type": "Arrow",
      "inhibitTransition": true,
      "source": "writing",
      "target": "shutdown",
      "weight": [1]
    },
    {
      "@type": "Arrow",
      "inhibitTransition": false,
      "source": "online",
      "target": "shutdown",
      "weight": [1]
    },
    {
      "@type": "Arrow",
      "inhibitTransition": false,
      "source": "shutdown",
      "target": "offline",
      "weight": [1]
    },
    {
      "@type": "Arrow",
      "inhibitTransition": false,
      "source": "offline",
      "target": "restart",
      "weight": [1]
    },
    {
      "@type": "Arrow",
      "inhibitTransition": false,
      "source": "restart",
      "target": "online",
      "weight": [1]
    }
  ],
  "description": "Readers share the database, a writer needs it alone. -o says 'only while empty', <-> says 'only while there is a token'.",
  "name": "Readers and writers",
  "places": {
    "readers": {
      "@type": "Place",
      "capacity": [null],
      "initial": [2],
      "label": "Idle readers",
      "offset": 0,
      "x": 120,
      "y": 120
    },
    "reading": {
      "@type": "Place",
      "capacity": [null],
      "initial": [0],
      "label": "Reading",
      "offset": 0,
      "x": 360,
      "y": 120
    },
    "writers": {
      "@type": "Place",
      "capacity": [null],
      "initial": [1],
      "label": "Idle writers",
      "offset": 0,
      "x": 120,
      "y": 320
    },
    "writing": {
      "@type": "Place",
      "capacity": [null],
      "initial": [0],
      "label": "Writing",
      "offset": 0,
      "x": 360,
      "y": 320
    },
    "online": {
      "@type": "Place",
      "capacity": [null],
      "initial": [1],
      "offset": 0,
      "x": 600,
      "y": 220
    },
    "offline": {
      "@type": "Place",
      "capacity": [null],
      "initial": [0],
      "offset": 0,
      "x": 840,
      "y": 220
    }
  },
  "token": [],
  "transitions": {
    "start_read": {
      "@type": "Transition",
      "x": 240,
      "y": 120
    },
    "end_read": {
      "@type": "Transition",
      "x": 240,
      "y": 40
    },
    "start_write": {
      "@type": "Transition",
      "x": 240,
      "y": 320
    },
    "end_write": {
      "@type": "Transition",
      "x": 240,
      "y": 400
    },
    "shutdown": {
      "@type": "Transition",
      "x": 720,
      "y": 160
    },
    "restart": {
      "@type": "Transition",
      "x": 720,
      "y": 280
    }
  }
}
```

</details>

</td></tr>
</table>
<!-- /example:readers-writers -->

#### lotka-volterra: colours as species, rates as mass-action

Two colours, one place each, three transitions with rates. Prey have no capacity and breed from themselves, so the net is unbounded, and the advisor says so with the firing sequence that shows it. CID `z4EBG9jFGHBX8w1mXi5Wi4SUvv5u7Rf5QD5Nzg3EesHA6VBhpay`.

<!-- example:lotka-volterra -->
<table>
<tr><th align="left">notation: <code>lotka-volterra.pnet</code></th><th align="left">JSON-LD: <code>lotka-volterra.jsonld</code></th></tr>
<tr><td valign="top">

```pflow
#! pflow 1
net "Lotka-Volterra"
about "Prey breed, predators eat prey to breed, predators die. Rates are mass-action."
color blue, red

place Prey = 40 blue @ 630, 350
place Predator = 8 red @ 930, 350

transition prey_birth rate 0.5 label "prey birth" @ 750, 290
transition predation rate 0.02 label "predation" @ 780, 410
transition predator_death rate 0.4 label "predator death" @ 1050, 350

Prey*1 blue -> prey_birth
prey_birth -> Prey*2 blue
Prey*1 blue -> predation
Predator*1 red -> predation
predation -> Predator*2 red
Predator*1 red -> predator_death
```

</td><td valign="top">

<details><summary>93 lines</summary>

```json
{
  "@context": "https://pflow.xyz/schema",
  "@type": "PetriNet",
  "@version": "1.1",
  "arcs": [
    {
      "@type": "Arrow",
      "inhibitTransition": false,
      "source": "Prey",
      "target": "prey_birth",
      "weight": [1, 0]
    },
    {
      "@type": "Arrow",
      "inhibitTransition": false,
      "source": "prey_birth",
      "target": "Prey",
      "weight": [2, 0]
    },
    {
      "@type": "Arrow",
      "inhibitTransition": false,
      "source": "Prey",
      "target": "predation",
      "weight": [1, 0]
    },
    {
      "@type": "Arrow",
      "inhibitTransition": false,
      "source": "Predator",
      "target": "predation",
      "weight": [0, 1]
    },
    {
      "@type": "Arrow",
      "inhibitTransition": false,
      "source": "predation",
      "target": "Predator",
      "weight": [0, 2]
    },
    {
      "@type": "Arrow",
      "inhibitTransition": false,
      "source": "Predator",
      "target": "predator_death",
      "weight": [0, 1]
    }
  ],
  "description": "Prey breed, predators eat prey to breed, predators die. Rates are mass-action.",
  "name": "Lotka-Volterra",
  "places": {
    "Prey": {
      "@type": "Place",
      "capacity": [null, null],
      "initial": [40, 0],
      "offset": 0,
      "x": 630,
      "y": 350
    },
    "Predator": {
      "@type": "Place",
      "capacity": [null, null],
      "initial": [0, 8],
      "offset": 0,
      "x": 930,
      "y": 350
    }
  },
  "token": ["https://pflow.xyz/tokens/blue", "https://pflow.xyz/tokens/red"],
  "transitions": {
    "prey_birth": {
      "@type": "Transition",
      "label": "prey birth",
      "rate": 0.5,
      "x": 750,
      "y": 290
    },
    "predation": {
      "@type": "Transition",
      "label": "predation",
      "rate": 0.02,
      "x": 780,
      "y": 410
    },
    "predator_death": {
      "@type": "Transition",
      "label": "predator death",
      "rate": 0.4,
      "x": 1050,
      "y": 350
    }
  }
}
```

</details>

</td></tr>
</table>
<!-- /example:lotka-volterra -->

#### pipeline: composition

Two copies of `bounded-buffer`, by CID, with one event link: the first buffer's `consume` and the second's `produce` are the same event, so an item moves across. `Flatten` gives four places and three transitions, one of them named `handoff` after the link. CID `z4EBG9j4Gw7zJjC7qSNxED5uvEn4TdA3619Nr5sHB8ToMaW7gE6`. This document is the composition as the design says `compose` compiles; the prototype does not compile `compose`, and the test that holds it is `TestCompositionExample`.

<!-- example:pipeline -->
<table>
<tr><th align="left">notation: <code>pipeline.pnet</code></th><th align="left">JSON-LD: <code>pipeline.jsonld</code></th></tr>
<tr><td valign="top">

```pflow
#! pflow 1
compose "Two buffers in series" namespace arc_merge sum
about "The consumer of the first buffer and the producer of the second are one event: an item moves across."

part first ResourceNet = z4EBG9jH9s6PYwJmBooUjcs85bYCBFfaCfhBDjaTZ8nk41ZBExS
part second ResourceNet = z4EBG9jH9s6PYwJmBooUjcs85bYCBFfaCfhBDjaTZ8nk41ZBExS

link handoff event first.consume ~ second.produce
```

</td><td valign="top">

<details open><summary>36 lines</summary>

```json
{
  "@context": "https://pflow.xyz/schema",
  "@type": "PetriNetBundle",
  "arc_merge": "sum",
  "description": "The consumer of the first buffer and the producer of the second are one event: an item moves across.",
  "links": [
    {
      "from": {
        "subnet": "first",
        "transition": "consume"
      },
      "id": "handoff",
      "kind": "event",
      "to": {
        "subnet": "second",
        "transition": "produce"
      }
    }
  ],
  "name": "Two buffers in series",
  "namespace": true,
  "subnets": [
    {
      "@type": "PetriNet",
      "cid": "z4EBG9jH9s6PYwJmBooUjcs85bYCBFfaCfhBDjaTZ8nk41ZBExS",
      "id": "first",
      "net_type": "ResourceNet"
    },
    {
      "@type": "PetriNet",
      "cid": "z4EBG9jH9s6PYwJmBooUjcs85bYCBFfaCfhBDjaTZ8nk41ZBExS",
      "id": "second",
      "net_type": "ResourceNet"
    }
  ]
}
```

</details>

</td></tr>
</table>
<!-- /example:pipeline -->

## 2. The grammar

[`docs/notation/pflow.ebnf`](notation/pflow.ebnf) is the grammar, and it is the only copy: ISO 14977 in the subset BeatScript's `crates/djlive/grammar.ebnf` uses, so one reader reads both. Section titles are `(* == Title == *)`, an UPPER-CASE name that is no production is a token class of the lexer, and a note after a `;` is that production's gloss. Its core fits on a screen:

```
program     = { line } ;
line        = [ statement ] NEWLINE ;
place       = "place" id [ "=" marking ] { pattr } ;
arcs        = group arrow group { arrow group } ;
operand     = id [ "*" marking ] ;
arrow       = "->" | "-o" | "<->" ;
```

Three things hold it to what it describes, all in `internal/notation/grammar_test.go`:

- **it is well formed**: every name used is defined and every production is used (the reader's `problems()`), and the token classes are exactly `CID INT JSON KIND NAME NEWLINE NUMBER STRING URI`;
- **every example is a sentence of it**: a recogniser reads the lexer's tokens against the productions, the composition example included, though the prototype's parser does not;
- **every sentence it writes is a program the parser reads**: a seeded walk of the core productions writes 2,400 statements, and each one parses. The grammar cannot say more than the language is.

That is BeatScript's drift test (`crates/djlive/tests/grammar.rs`), ported. And **BeatScript's own EBNF reader and railroad renderer read this file unmodified**: copied as they are at BeatScript `origin/main` a86b975 into a scratch crate and built on a build host, `ebnf::read` finds 33 productions, 9 token classes and no problems, `railroad::svg` draws all 33, and the result is [`docs/notation/railroad.html`](notation/railroad.html). That is the evidence for §5; the copy was a scratch and is not in this change.

<details><summary>The whole grammar (generated: <code>go test ./internal/notation -update</code> rewrites this block)</summary>

<!-- pflow.ebnf: generated from docs/notation/pflow.ebnf -->
```ebnf
(* == Programs and lines == *)
program     = { line } ;
line        = [ statement ] NEWLINE ;                         (* an empty line and a comment line are lines *)
statement   = pragma | net | about | color | parents | place | transition | arcs
            | ext | compose | part | port | link ;

(* == The header == *)
pragma      = "#!" "pflow" INT ;                              (* #! pflow 1: the notation's version, the first line *)
net         = "net" [ KIND ] [ STRING ] ;                     (* net ResourceNet "Bounded buffer": the @type and the name *)
about       = "about" STRING ;                                (* the net's description *)
color       = "color" cdecl { "," cdecl } ;                   (* the token colours, in the order of every vector *)
cdecl       = NAME [ "=" URI ] ;                              (* red   or   prey = <https://pflow.xyz/tokens/blue> *)
parents     = "parents" CID { "," CID } ;                     (* the nets this one was made from, newest first *)

(* == Places and transitions == *)
place       = "place" id [ "=" marking ] { pattr } ;          (* place slots = 3 cap 3 @ 200, 100 *)
pattr       = "cap" marking                                   (* the capacity: nothing said is unbounded *)
            | "label" STRING                                  (* the name the editor shows *)
            | "about" STRING                                  (* the description *)
            | "offset" NUMBER                                 (* the editor writes 0; only another value is written out *)
            | at ;
transition  = "transition" id { tattr } ;                     (* transition brew rate 0.25 @ 350, 300 *)
tattr       = "rate" NUMBER                                   (* the mass-action rate the ODE and SSA engines read *)
            | "label" STRING
            | "about" STRING
            | "role" NAME                                     (* the editor's role: default, ... *)
            | "offset" NUMBER
            | at ;
at          = "@" NUMBER "," NUMBER ;                         (* where the editor draws it: part of the document, so part of its CID *)
id          = NAME | STRING ;                                 (* a reserved word, or a name with odd characters, is quoted *)

(* == Markings, capacities and weights == *)
marking     = list | sum ;
list        = "[" [ item { "," item } ] "]" ;                 (* the vector as the document holds it: [1, 0, 2]  [null] *)
item        = NUMBER | "null" ;
sum         = term { "+" term } ;                             (* 2 red + 1 blue: the vector, a zero for every colour not named *)
term        = NUMBER [ NAME ] ;                               (* 3 brown   or just 3 in a net with no more than one colour *)

(* == Arcs == *)
arcs        = group arrow group { arrow group } ;             (* one statement, as many arcs as its hops pair up, in order *)
group       = operand { "," operand } ;
operand     = id [ "*" marking ] ;                            (* the weight is written on the place: beans*2 brown *)
arrow       = "->"                                            (* consume or produce, by the direction *)
            | "-o"                                            (* inhibitor: the place must hold fewer than the weight *)
            | "<->" ;                                         (* read: the place must hold the weight, nothing moves *)

(* == Composition [next] == *)
compose     = "compose" [ STRING ] { cattr } ;                (* a file composes the nets it names into one model *)
cattr       = "namespace" | "arc_merge" ( "sum" | "max" ) ;
part        = "part" NAME [ KIND ] "=" ( CID | NAME ) ;       (* a subnet, by the CID of a stored net or by a name in this file *)
port        = "port" NAME "." NAME pkind [ "place" | "transition" ] id ;
pkind       = "in" | "out" | "inout" | "observe" ;            (* the boundary point a part shows, and which way it faces *)
link        = "link" [ NAME ] lkind endpoint "~" endpoint [ "when" STRING ] [ "lowering" NAME ] ;
lkind       = "token" | "data" | "event" | "guard" ;          (* place fusion, observation, transition fusion, a gate *)
endpoint    = [ "port" | "place" | "transition" ] NAME "." NAME ;

(* == Anything else the document holds [next] == *)
ext         = "ext" [ ( "place" | "transition" ) id ] STRING "=" JSON ;   (* a key the notation has no word for, kept as JSON *)
```
<!-- /pflow.ebnf -->

</details>

## 3. Round trips

### 3.1 The rule

**The CID of a text is the CID of the document it compiles to. There is no other.**

```
compile : Text → JSON-LD        total on programs with no errors
print   : JSON-LD → Text        total on the editor's documents; reports what it could not carry
cid(t)  := seal(compile(t))     and seal(d) is the contract of internal/seal, unchanged
```

BeatScript hashes its text; pflow cannot, because every CID that exists names a document, and the sealing contract is [explicitly unchanged](model-identity.md#the-sealing-contract-is-unchanged). A text is the source and the document is what it means.

### 3.2 The laws

| | statement | held by |
|---|---|---|
| **L1** text and document agree | for every checked text `t`, `seal(compile(t))` is the CID of the document `compile(t)`, and the JSON-LD file written beside the text seals to the same CID | `TestExamples` (six examples, `cids.json`) |
| **L2** document → text → document | for every editor-profile document `d`, `seal(compile(print(d))) = seal(d)`, and `compile(print(d))` is the same JSON-LD as `d` up to key order and the spellings of §3.3 | `TestExamples`; the two parity fixtures against `parity/golden.json`; `TestEveryNetInTheRepo…` (every net in the repository) |
| **L3** text → document → text | `print(compile(t))` is a fixed point: printing what it compiled to again gives the same text | `TestExamples` |
| **L4** trivia is not identity | comments, blank lines, spacing, chains and groups, and the names a colour is written by cannot change a CID | `TestTriviaDoesNotChangeTheCID`, `TestChainsAndGroupsExpandInOrder` |
| **L5** failure is loud | every conversion can return both CIDs, and a mismatch is a failure, not a note | `pflowtext roundtrip` exits 1 on one |

L2 is checked by CID, not by claim. `print` returns a `lossy` list of what the core subset could not carry, and the tool does not rely on it: it compiles the text it printed and compares seals. A document with a non-empty `lossy` is not held to L2 and says why; a document with an empty one is, and **across every net in this repository small enough to seal quickly, 13 carry with identical CIDs, and the 12 that do not each name what they lack** (`author` on six; the hand-written minimal fixtures in `testdata`, which have no `capacity`, `offset` or `inhibitTransition`, on the rest). In this repository no document has printed clean and come back different, and the test fails if one does.

### 3.3 What the sealer ignores, and what it keeps

The notation's freedom, and its obligations, are exactly this table. Every row was run through `internal/seal`; the first three of the "same" rows and the hazard are `TestSealingEquivalencesTheDesignRelies`.

| two documents that differ in… | same CID? | so the text… |
|---|---|---|
| top-level `@id` | **same** | never writes it; a stored net's `@id` is its own CID |
| key order inside an object | **same** | prints keys sorted; the editor's order is not kept |
| the order of `places`, `transitions` | **same** | keeps the order declared, as presentation only |
| the order of `arcs`, `token`, `parents` | **different** (`@list`) | keeps the order: arcs print in document order |
| `capacity: [null]`, `[]`, `[null, null]` | **same** (nulls vanish from a list) | writes no `cap`; compile writes `[null]` as the editor does |
| `capacity` absent vs `[null]` | different | always writes `capacity` (the editor profile) |
| `capacity: [0]` vs `[null]` | different | tells them apart: a sum writes zeros, nothing writes null |
| `3`, `3.0`, `1e0` | **same** | prints the shortest form |
| `token` absent vs `[]` | different | always writes `token` |
| `offset` absent vs `0` | different | writes `offset: 0` on every place |
| a place's `initial: []` vs `[0]` | different | `= []` is a list; nothing said is `[0]` |
| an arc's `weight` absent vs `[1]` | different | always writes `weight` |
| **`capacity: [null, 3]` vs `[3]`** | **same** | a hazard, §8 |

### 3.4 The editor's profile

`compile` always writes what the editor writes: `@context`, `@type`, `@version: "1.1"`, `token`, and for each place `@type`, `capacity`, `initial`, `offset`; for each arc `@type: "Arrow"`, `inhibitTransition`, `source`, `target`, `weight`. The output of every example passes the editor's own strict check unchanged: `node scripts/check-nets.mjs` says 0 errors and 0 warnings for each of the five single nets (`TestExamplesPassTheEditorsOwnCheck` runs it).

### 3.5 Canonical formatting

`print` writes, and `fmt` (below) normalises to: the pragma first; then `net`, `about`, `color`, `parents`; a blank line; every `place`; a blank line; every `transition`; a blank line; every arc, **one to a line, in the document's order**. One space between tokens, no alignment and no trailing space, so the formatter is a function of the document alone. Attributes in a fixed order (places: `= cap label about offset @`; transitions: `rate label about role offset @`). Numbers in their shortest form; strings as JSON; ids bare when they are plain names and not reserved, quoted otherwise. Sums list the non-zero terms in colour order; an all-zero vector is `0` (and `0 <first colour>` when there are several).

`fmt` is **text to text**, and keeps what `print` cannot: comments, blank lines the author left between sections, and the author's chains and groups (the canonical *print* expands them because a document has no memory of them). It changes spacing, attribute order and number spelling only; it is idempotent. It is designed here and not in the prototype, which has `print` only. Anything in a text that is not in the document (comments, chains) is lost by `compile` then `print`, and that is by design (L4).

### 3.6 Layout is identity

`x` and `y` are in the sealing context and in every stored document, so **a net with positions and the same net without them are two CIDs.** The notation lets the text omit them (`@` is optional), and what that costs is stated plainly: a hand-written text has the CID of its layout-free document; opened in the editor and saved, it gains positions and becomes a new document whose `parents` should name the old one. The editor already has the right tool for the middle step: `public/petri-layout.js` is pure and deterministic ("the same model always gives the same positions"), and `bounded-buffer`'s positions are what its `auto` layout gives the draft with none. A formatter flag, `fmt --layout`, would write them into the text: a pass that changes the CID on purpose, and says so.

### 3.7 Where the notation stops

- **Off-profile documents** (a missing `offset`, a weight absent): not carried; `print` says which key.
- **`author`, `goals`, `views`, `ext`**: not in the core; `ext` is the escape, in the grammar only.
- **Composition**: the text is specified (§1.9) and compiles by hand to a document `internal/model` accepts; the prototype does not read it.
- **Big nets**: sealing is superlinear in the document (`docs/composition-documents.md` §1.3: URDNA2015 over thousands of blank nodes), so the round-trip check on a large game net takes minutes. The text is fine; the check is what is slow, and the test skips nets over 60 elements.

## 4. The advisor

BeatScript's editor shows the parse error where it happened, the page's `check` result as squiggles, and the language service (`beatscriptls`) on top. The pflow advisor is the same three layers, fed by checks pflow already has.

### 4.1 Three tiers, as in `beatscriptls`

| tier | what it reads | when | costs | the prototype |
|---|---|---|---|---|
| **syntax** | the lexer's tokens, one line at a time | every keystroke | microseconds | `Parse` |
| **check** | names, colours, ranges, the shape of every arc | every change | microseconds, no search | `File.Check` |
| **analysis** | the compiled net, through go-pflow's verifier | when the text has rested (150 ms, the figure `beatscriptls` uses), cancellable; a result for a version the text has left is dropped | milliseconds for the examples; 270 ms at 20,000 markings | `Advise` |

As in BeatScript, until the analysis of a version is in, the diagnostics shown are the earlier tiers'. The analysis never runs on a text with errors: the net is not defined.

### 4.2 The protocol

A diagnostic is BeatScript's (`djlive::diag::Diagnostic`, as `beatscript-api`'s `diagnostic_json` and `beatscriptls` carry it), with three additions:

```jsonc
{
  "severity": "error",                    // error | warning | info          (LSP 1, 2, 3, as beatscriptls maps them)
  "source": "check",                      // syntax | check | analysis        (new: which tier)
  "line": 4, "col": 15, "end_col": 16,    // 1-based, columns in characters
  "start": 61, "end": 62,                 // byte offsets
  "start16": 61, "end16": 62,             // UTF-16 offsets, what a JS string slices with
  "message": "`slots` starts with 3 but holds at most 2",
  "expected": [], "found": "",
  "help": "the editor would clamp the marking to the capacity; the net you wrote is not the net you would get",
  "related": [ {"line": 8, "col": 7, "end_col": 12, "start": 143, "end": 148, "message": "also in the law"} ],   // new: other spans it is about
  "data": null,                           // new: what a client acts on without reading the message
  "render": "error: …\n --> 4:15 …"       // the caret form, for a terminal or a model
}
```

`data` for the analysis tier is `{kind, verdict, method, witness?, evidence?, law?}`: `verdict` is `proved`, `refuted` or `unknown`, `method` the verifier's (`structural`, `exhaustive`, `witness`, `partial`), `witness` a replayable firing sequence. Over LSP the same thing is `textDocument/publishDiagnostics` (`related` is `relatedInformation`, `data` is `data`) and a `pflow/diagnostics` request beside it, as `beatscript/diagnostics` is. `Diagnostic.JSON` in the prototype writes exactly this.

### 4.3 Syntax: errors with line, column and what was expected

The grammar is one statement to a line, so a bad line is reported and skipped and the lines around it still count. A line that declares a place or a transition and then fails still *declares* it, so the arcs that use it are not reported as naming nothing on top of the real error.

```
$ pflowtext check bad.pnet                       # (the check tier's errors follow below)
error: a number or a `[...]` list is written here: the capacity
 --> 5:16
  |
5 | place items cap
  |                ^
  = expected: a number or [
  = found: the end of the line

error: a transition line takes `rate`, `label`, `about`, `role`, `offset` and `@ x, y`
 --> 6:20
  |
6 | transition produce rat 1
  |                    ^^^
  = expected: rate, label, about, role, offset or @
  = found: rat
```

### 4.4 Check: the editor's rules, on the line that broke them

Every rule here is one `public/petri-validate.js` ("Check net") already has; the notation moves it from a JSON path (`places.slots.initial[0]`) onto the text, with a suggestion where there is one.

```
error: `slots` starts with 3 but holds at most 2
 --> 4:15
  |
4 | place slots = 3 cap 2
  |               ^
  = help: the editor would clamp the marking to the capacity; the net you wrote is not the net you would get

error: `slot` is not declared: an arc joins a place and a transition that exist
 --> 8:1
  |
8 | slot -> produce -> items
  | ^^^^
  = found: slot
  = help: did you mean `slots`?
```

| rule | severity |
|---|---|
| a name declared twice; a place and a transition sharing a name | error |
| an arc end that is not declared (with the nearest name) | error |
| an arc that joins two places or two transitions; `-o` and `<->` the wrong way round | error |
| a weight on the transition end | error |
| a colour that is not declared (with the nearest, or "declare it first"); named twice | error |
| a bare weight or marking in a net with more than one colour | error |
| marking over capacity | error |
| a label that is empty, over 100 characters or over one line; a negative rate | error |
| a `Kind` other than `PetriNet`: the editor's Check net rejects it (§8) | warning |
| a weight of 0; a place or transition with no arcs | warning |

### 4.5 Analysis: the verifier's verdicts, on the lines responsible

The advisor adds no analysis of its own. It asks go-pflow's `verify` package (the engine behind `pflow_verify`) four questions (`bounded`, `deadlock-free`, `live`, `l4-live`) and the incidence matrix for the P-invariants, then anchors each answer:

| verdict | severity | anchored on | carries |
|---|---|---|---|
| a P-invariant `readers + reading == 2` | info | the first place of the law; `related` points at the rest | the law, "proved from the incidence matrix: no search was needed" |
| `bounded` proved (every place covered by a positive invariant, or the search finished) | info | the `net` line | the method and the invariants that prove it |
| `bounded` refuted | warning | the first place that grows; `related` the others | the firing sequence that pumps it |
| `deadlock-free` refuted | warning | the `net` line | the firing sequence to the dead marking |
| `live` refuted: transitions no reachable marking enables | warning | each such transition's line | |
| `l4-live` refuted: transitions that can be shut out for good | warning | each such transition's line | the sequence after which |
| anything `unknown` | **one** info | the `net` line | how many markings were searched, and "an unknown is not a pass" |

What it says on the examples, run with `pflowtext check -advise 2000`:

```
readers-writers.pnet
info: bounded: every place is covered by a P-invariant, so the net is bounded for any initial marking
2 | net "Readers and writers"
  = help: structural: P-invariants: offline + online == 1; readers + reading == 2; writers + writing == 1
info: deadlock-free: no deadlock among all 5 reachable states            (exhaustive)
info: conserved: readers + reading == 2, at every reachable marking      on line 5, `place readers`; related: line 6, `reading`
info: conserved: writers + writing == 1, at every reachable marking      on line 7
info: conserved: offline + online == 1, at every reachable marking       on line 9

lotka-volterra.pnet
info: deadlock-free, live, l4-live: unknown, the search stopped at 2000 markings
warning: unbounded: place(s) Prey.blue grow without bound               on line 6, `place Prey`; related: line 7
  = help: add a capacity, or let the net give the token back (fire prey_birth)

coffee-shop.pnet   at 2000 markings:  one info, "bounded, deadlock-free, live, l4-live: unknown, the search stopped at 2001 markings"
coffee-shop.pnet   at 20000:          info: bounded across all 2706 reachable states; info: no deadlock among all 2706 reachable states
```

Four things the real output taught:

1. **Unknown is a first-class answer.** At 2,000 markings the coffee shop is neither proved nor refuted, though every place has a finite capacity and the state space is 2,706 markings. The advisor says unknown once and offers the bound (as `pflow_verify` does: default 2,000, at most 20,000); it never turns "I stopped" into "fine". (The verifier does not use capacities to bound a place structurally; that is a verifier improvement, not an advisor one.)
2. **A law with value 0 is dropped.** `Prey.red == 0` only says a colour copy no arc touches stays empty. The unfolded names are mapped back (`Prey.blue` is the place `Prey`, colour `blue`) so the squiggle lands on the declaration.
3. **A refutation is not always a bug.** `knapsack` reports `deadlock-free is refuted: 3 deadlock state(s) reachable`: a search plan *ends*. The warning is right and the author may mean it. What must not happen is silencing it by a comment that changes the advisor's behaviour: comments are trivia (L4), and a switch that is not a statement is a habit, not structure. The answer is §1.10's `expect` (`expect deadlock`), compiled to the `ModelContent` sidecar and not into the CID; the advisor reads it from there.
4. **The mutual exclusion in `readers-writers` is not found by default.** "A reader and a writer are never active together" is a property the author states (`verify`'s `mutual-exclusion`, `unreachable{target}`), not one the four default questions ask. Same fix: it is an `expect`.

### 4.6 What the editor draws

The editor draws the same data BeatScript's does: a squiggle under the span, a gutter mark on the line, the message on hover, and, new, `related` spans lit when the cursor is on one of them. A rendering of the real diagnostics above (the CLI prints the same data as text):

```
 1  #! pflow 1
 2  net "Readers and writers"                       ⓘ bounded · deadlock-free (5 markings, searched in full)
 3  about "Readers share the database, …"
 4
 5  place readers = 2 label "Idle readers" @ …      ⓘ readers + reading == 2     ↔ 6
 6  place reading label "Reading" @ 360, 120        ⓘ …                            ↔ 5
 7  place writers = 1 label "Idle writers" @ …      ⓘ writers + writing == 1     ↔ 8
 …
```

An `info` is drawn as an inlay hint at the end of the line, not a squiggle; a `warning` as a squiggle with a lightbulb when there is a fix; an `error` as a red squiggle. `data.kind` lets a client choose.

### 4.7 Fixes (designed; not in the prototype)

`did you mean` renames; **write the colour** (`p*1 red`); **declare the colour**; **clamp the marking** or **raise the capacity**; **add a capacity** to a place the verifier says grows; **quote the reserved word**; **fill in layout** (`petri-layout.js`, with the CID change said); **replay the witness** (a code lens that fires the sequence in the editor); **format**. Each is a code action carrying an edit, proved by compiling the result, as `beatscriptls`'s refactors are "made and proved on resolve".

### 4.8 Where it runs

The editor already runs pflow-native's command registry in WebAssembly (`public/petri-wasm.js`, 88 commands exposed), its Structure dialog (`petri-analysis-ui.js`: invariants, siphons, verify, reach, the reachability graph) calls checks of the kind the advisor needs, and the MCP tools are the same checks (`pflow_validate`, `pflow_verify`, `pflow_reachability`). So the advisor's third tier is a **call to those commands on the compiled document**, not a new engine in a new place, and the first two tiers want to sit in the same wasm module so the editor, the MCP server and a CLI cannot disagree (§5). The Go prototype calls the same checks from go-pflow.

## 5. Tooling reuse

The request was: what to share with BeatScript, and where shared code lives. What the prototype and the unmodified-reader experiment (§2) show:

| piece | BeatScript today | for pflow | how | taste |
|---|---|---|---|---|
| **EBNF reader**, `problems()`, sections, classes | `djlive/src/grammar/ebnf.rs`, 434 lines, std only | read `pflow.ebnf` unchanged: 33 productions, no problems | share as is | take it out of `djlive` |
| **railroad renderer** and its CSS, own layout, no diagram library | `railroad.rs`, 309 lines | drew all 33 productions of pflow's grammar unmodified | share as is | the same crate |
| **grammar page** | `page.rs`, 251 lines | the same page, other grammar (`railroad.html` is a stand-in) | share; its text is BeatScript's | with the crate |
| **recogniser** (a sentence of the grammar?) | `recognize.rs`, 370 lines; reads `djlive`'s own `Token` | ported in Go (~120 lines); needs a token-class trait to be shared | share behind `trait Tokens { fn class_matches(…) }` | yes, the one change worth making |
| **sentence writer** (the other half of the drift test) | `generate.rs`, 388 lines; class samples are BeatScript's | ported (~60 lines) | share the walk, each language gives its samples | yes |
| **diagnostic type** and its JSON | `djlive/src/diag.rs`, 185 lines, and `report.rs`'s `diagnostic_json` | the same fields plus `source`, `related`, `data` | share; the three additions are backward compatible | yes: one protocol is the point |
| **UTF-16 index** | `beatscript-api/src/utf16.rs`, 71 lines | needed for every JS client | share | |
| **language-service skeleton** | `beatscriptls` `server.rs`, `text.rs`, `json.rs`, `diagnostics.rs`: 404 + 199 + 57 + 56 lines of LSP plumbing, position encodings, two tiers, stale-result dropping | the same plumbing, other language | share behind `trait Language { fn syntax(…); fn check(…); … }` | an LSP for pflow is cheap *after* this, expensive before it |
| **editor component** (textarea over a `<pre>`, squiggles, gutter, popups) | `site/web/js/editor.js` 558, `assist.js` 604, `assist-model.js` 160, `highlight.js` 64, `errors.js` 96, `geometry.js`, `wrap-model.js` | the pflow editor is a canvas with a text pane to come | vendor as ESM with a lock | yes, last |
| **highlight classes**, TextMate grammar | `highlight.rs`, 80 lines; `beatscript.tmLanguage.json`, hand kept, held to djlive's word lists by a test | generate the TextMate grammar from the EBNF's terminals and a class map | each language owns its classes; the generator is shared | |
| lexer, parser, checker, completion data | `djlive` | `internal/notation` | **not shared** | |

Where shared code lives: three honest choices.

- **A. A new zero-dependency repo, `stackdump/langkit`** (MIT): `ebnf`, `railroad`, `diag`, `lsp`, and an ESM `editor`. BeatScript and pflow-native depend on it by git tag, and each keeps a lock (`langkit.lock`: tag and sha256), the way `pflow-js.lock` and `pflow-native-wasm.lock` already pin vendored code. One home, no cycles. Costs a repo and a release habit.
- **B. A crate inside the BeatScript repo** that pflow-native takes by git dependency. No new repo, but pflow depends on a music repo that builds an audio engine, and BeatScript's `djlive` stays the place its tests live.
- **C. Copy and lock**: copy `ebnf.rs` and `railroad.rs` into pflow-native with a lock that fails when they drift. What `pflow-js.lock` does for JS. Cheapest, and exactly the divergence the CLAUDE.md warns about for shared browser JS.

**Recommendation: A**, in this order: `ebnf` + `railroad` first (they already work unmodified, which §2 shows, and extracting them is moving two files), then `diag`, then the `Tokens` trait for the recogniser, then `lsp`, and the editor ESM last. The first step needs no pflow code at all and can be done and reviewed on its own.

**Where the notation's reference implementation lives** is a separate question: **`pflow-native`'s `core`** (Rust, where `cid::seal`, the command registry and the wasm build already are), with `parity/notation/` goldens (text, JSON-LD, CID) checked by Go, JS and Rust, the way `parity/golden.json` already is. The Go prototype here is the executable specification those goldens would come from. The alternative, Go as the reference and a JS port for the browser, is the repository's older pattern and costs a second parser to keep in step.

## 6. The prototype

`internal/notation` (MIT, about 2,700 lines of Go and 1,450 of tests): `lex.go`, `parse.go` (a line at a time, with recovery), `ast.go`, `check.go`, `compile.go`, `print.go`, `ojson.go` (an order-preserving JSON reader and writer, because key order and number text matter), `diag.go`, `advise.go`, `cmd/pflowtext`. Imports only `internal/seal` and go-pflow (`parser`, `reachability`, `verify`); served by `POST /api/notation` (`cmd/webserver/notation.go`) for the IDE shell's notation panel.

| subset | in | out |
|---|---|---|
| statements | pragma, `net`, `about`, `color`, `parents`, `place`, `transition`, arcs (`->`, `-o`, `<->`, weights, chains, groups) | `compose`, `part`, `port`, `link`, `ext` (in the grammar, refused by the parser with a message saying so) |
| conversions | text → JSON-LD, JSON-LD → text, CID | text → text `fmt` that keeps comments and chains |
| advisor | syntax, check, analysis through `verify` | code actions, an LSP |

Tests (25 top-level, all in `go test ./internal/notation`):

- the six examples compile to the JSON-LD beside them, byte for byte; text, JSON-LD and the printed text seal to one CID; the printed text is a fixed point;
- **`coffee-shop` and `knapsack`, the two real pflow.xyz nets, are held to the golden CIDs in `parity/golden.json`**, and their notation is what `print` writes for the fixtures;
- every net in the repository either round-trips with the same CID or names what it lacks;
- the grammar is well formed, every example is a sentence of it, a recogniser rejects eleven bad lines, and 2,400 sentences it writes all parse;
- syntax errors carry line, column and the expected set, and a bad line does not hide the lines after it;
- the check tier's rules, the diagnostic JSON's shape and UTF-16 offsets, trivia that cannot change a CID, the sealing equivalences of §3.3;
- the advisor: laws on the right lines, a refutation with its witness, unknown at the default bound and proved at 20,000, a dead transition on its own line;
- the composition example passes `internal/model` (identity, structure, `Flatten`: 4 places, 3 transitions, one named `handoff`).

Not verified: the Bazel `BUILD.bazel` files (written by hand in the style of `internal/seal`; `bazel` was not run), the JS and Rust sides, and anything in a browser.

## 7. Taste calls

Each is a choice with a recommendation; the first three are the ones that are expensive to reverse.

1. **The text is a way to write the document, never what is hashed.** Forced: the sealing contract is unchanged and every CID that exists names a document. What follows is the call: layout is part of identity (§3.6) and comments are not. The alternative, hashing the canonical text as BeatScript does, would give every net a second, different CID and break the contract's one-name-per-net.
2. **Name and extension: "pflow notation", `.pnet`.** `.pflow` is taken: `cafe-loyalty.pflow` and go-pflow's `tokenmodel/dsl` and pflow-rs's `pflow-dsl` use it for the S-expression schema language. A brand name (BeatScript has one) can wait until it has users. `.pnet` is short and unclaimed here; `.pflownet` is the careful alternative.
3. **Layout is optional in the text.** `@ x, y` can be left out; the cost (a layout-free text and the saved net are two CIDs, §3.6) is stated, and the editor's own `petri-layout.js` is the pass that fills it in. Requiring positions would make hand-writing unusable; moving them out of the document would change the contract.
4. **Weights on the place, with chains and groups as sugar.** `beans*2 brown`, `a, b -> t -> c`; canonical print is one arc per line. Alternatives: a weight on the arrow (`-[2]->`), where there is nothing to attach a colour name to without a long arrow; or no sugar, where `slots -> produce -> items` becomes four lines.
5. **Glyphs: `-o` inhibitor, `<->` read.** `-o` is the circle-headed arc of the literature. `<->` reads "needs it and gives it back" and prints as the single transition-to-place arc with the flag that is the editor's real encoding. Words (`inhibit`, `read`) are the alternative and cost the arc its shape.
6. **Explicit declarations.** `place` and `transition` before use, not arcs that declare by mention. It is what makes "did you mean `slots`" possible, gives a label, a layout and a rate somewhere to live, and catches a typo as an error rather than a new place. It costs lines on a four-node net.
7. **Colours by name; a bare weight in a coloured net is an error.** The alternative (a bare end means the first colour, as the editor's `[1]` pads with zeros) is shorter and is silently wrong the day a colour is added.
8. **Composition as a netlist, parts by name or CID.** It is what the document is, it reads in the order of the compose page's views, and the legality of a link stays go-pflow's. A part named by CID is brittle (any edit, a layout nudge included, changes it), so names in a file with the compiler pinning are the usable form.
9. **Assertions in a sidecar, not the net.** `expect`, `note` compiled to `ModelContent` (§1.10), so changing an expectation does not change identity. The alternative, `ext` in the net, puts judgment in the hash, which `model-identity.md` already rules out.
10. **The advisor's budget.** Analysis after a 150 ms rest, at most 2,000 markings by default and 20,000 on request (the numbers `pflow_verify` uses), one `unknown` note rather than four, never on a text with errors.
11. **Where the reference implementation lives.** `pflow-native` core (Rust, with `cid::seal`, the registry and the wasm build) with `parity/notation/` goldens in Go, JS and Rust, the Go prototype as the specification. The alternative, Go as the reference and a JS port, is the older pattern here and needs two parsers kept in step.
12. **Where shared code lives.** Option A of §5, a zero-dependency `langkit` repo, starting with the two files that already work unmodified. Options B and C are in §5.
13. **How it reaches the editor.** The cheapest first step is a paste: the clipboard format already says "any other text: fall back to the in-app clipboard" (`docs/clipboard-format.md`), and a notation paste slots into that fall-back. Then a read-only Text view with the diagnostics, then two-way editing with `fmt`. None of that is in this change.

## 8. Findings in code that already exists

Nothing below is changed here. They came out of running real nets through the real tools.

1. **Check net rejects the net type the landing page ships.** `public/petri-validate.js:82` makes any `@type` but `PetriNet` an error, and `examples/landing/producer-consumer.jsonld` is a `ResourceNet`: `node scripts/check-nets.mjs examples/landing/producer-consumer.jsonld` reports `@type: is "ResourceNet", not "PetriNet"`. (sim, the ontology and the Bundle's `net_type` use `ResourceNet`.) The notation warns on any other kind for that reason.
2. **The sealer drops a `null` inside a list**, so `capacity: [null, 3]` and `capacity: [3]` are one CID and mean different things in a two-colour net: the editor writes `Infinity` as `null`, so a net unbounded in its first colour and capped at 3 in its second seals as one capped at 3 in its first. A collision between two different nets; probably rare. `TestSealingEquivalencesTheDesignRelies` pins the behaviour.
3. **`capacity: [0]` and `[null]` mean the same to every engine (0 is unbounded) and seal differently.** Not a bug; the notation keeps them distinguishable (a sum writes zeros, nothing writes null).
4. **`author` is the commonest thing the core subset lacks** (six of the twelve nets that did not carry). It is stamped at save, so a hand-written net and the saved copy have different CIDs for that reason alone. `ext author` can carry it; the recommendation is that the save path owns it.
5. **A weight of `[0]` is read three ways**: "no requirement" by `petri-sim.js`, weight 1 by go-pflow and pflow-rs (the check's own warning says so; `producer-consumer.jsonld` has one). The notation writes `*0`, warns on it, and does not decide.
6. **`verify`'s `bounded` does not use capacities.** The coffee shop has a finite capacity on every colour of every place and the verifier says `unknown` at 2,001 markings; at 20,000 it finishes and proves it. A structural rule ("every place has a capacity on every colour") would prove it with no search.

## 9. Neighbouring notations

- **The S-expression token-model DSL** (`.pflow`; go-pflow `tokenmodel/dsl`, pflow-rs `pflow-dsl`, the `schema!` macro; `examples/showcase/cafe-loyalty.pflow`). It writes an *application schema*: data places (`map[string]int64`), actions with guards, key/value arcs (`(arc earn -> points :keys (member) :value amount)`), constraints. It has its own CID (`tokenmodel/cid.go`) and is read by the metamodel side. This notation writes the *editor's net*: places, tokens, weights, colours, rates, layout, and the document pflow.xyz seals. They are siblings, not rivals, and they already agree on `->`. They are not unified here: one is an S-expression and this is line-oriented, and the editor's net has no data types for a unification to carry. They should share the diagnostics protocol (§4.2).
- **PNML** (ISO/IEC 15909-2): an XML interchange format with a reader in go-pflow (`parser/pnml.go`). The notation is not an alternative to it; a PNML net printed as notation is one more way in.
- **BeatScript**: the sibling this follows, and the source of the reader, the renderer, the diagnostics shape and the drift test.
