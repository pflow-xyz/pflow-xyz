# The pflow notation: grammar and examples

A net written as text, one statement to a line, that compiles to the JSON-LD document pflow.xyz seals.
The design is [docs/pflow-notation.md](../pflow-notation.md). This directory holds the two things the
design says are data, not code:

| file | what | licence |
|---|---|---|
| [`pflow.ebnf`](pflow.ebnf) | the grammar: the one source of truth (ISO 14977, the subset BeatScript's `grammar.ebnf` uses) | CC0 |
| [`examples/*.pnet`](examples/) | six programs, each beside the JSON-LD it compiles to (`*.jsonld`) | CC0 |
| [`examples/cids.json`](examples/cids.json) | the CID each pair seals to, text and JSON-LD alike | CC0 |

The prototype that reads, checks, compiles and prints it, and the tests that hold it to the grammar and
the examples to their CIDs, are [`internal/notation`](../../internal/notation) (MIT):

```bash
go test ./internal/notation                 # grammar both ways, every example, the advisor, the round trips
go test ./internal/notation -update         # rewrite the .jsonld files, cids.json and the two real nets' text
```

`coffee-shop` and `knapsack` are pflow.xyz nets that already exist (`parity/fixtures/with-rates.jsonld`,
`parity/fixtures/knapsack.jsonld`); the test holds the text to the CIDs in `parity/golden.json`, which the
Go, JS and Rust sealers all reproduce.
