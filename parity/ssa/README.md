# parity/ssa — portable SSA goldens

Byte-exact fixtures for `public/petri-ssa.js`, replayed by
`public/petri-ssa_test.ts` in `make test-js`. Shape and semantics: the portable
SSA specification (`ssa-spec.md` §4) shared by go-pflow, pflow-rs, pflow-xyz
and pflow-jl. The test compares every parsed double with `!==`; never loosen
to a tolerance and never regenerate a fixture to make a test pass.

This repo **consumes** the goldens, it does not produce them: `go.mod` pins a
go-pflow release that predates the `stochastic` package, so there is no Go
generator or Go-side replay test here (unlike `parity/learn/gen`). The deno
fixture replay is the gate.

## Provenance

Canonical goldens are `go-pflow/stochastic/testdata/portable/<name>.json` on
go-pflow branch `discrete-stochastic`, written by go-pflow's `cmd/ssa-goldens`
(`make ssa-goldens` there) on the portable path (`Options{Portable: true}`).
The five files here are `cp` copies of those bytes; each file's `_comment`
names the go-pflow commit that generated it: `9e67d06bf66c60ca641c8e515d15545deafcb060`.
If go-pflow ever re-runs `make ssa-goldens`, no double may change — only the
`_comment` text — and the copies and the hashes below must be refreshed from
that commit.

| file | sha256 | source |
|---|---|---|
| chain.json | 892de18e6c8d7899ed8a7081b0da3b1de5c4eda143f16c627ab21919cea61832 | go-pflow `stochastic/testdata/portable/chain.json` |
| sir.json | 192035da7d6b848479a8f2586f1330caed19c8bf26ece2f4743017aef240e683 | go-pflow `stochastic/testdata/portable/sir.json` |
| dimer.json | 5b260cc9b3027c660d87d5a041839941f4deb1107a22728782549bc700e23341 | go-pflow `stochastic/testdata/portable/dimer.json` |
| gates.json | 9a2a35ef18b5218a1afcda49f1755e47feb9942bf07254533971e1d490df7009 | go-pflow `stochastic/testdata/portable/gates.json` |
| coffeeshop.json | 2e0402f8d6e0ec32956538e480f76d6e3ec28861cb03211eb97be6a68f9f0c53 | go-pflow `stochastic/testdata/portable/coffeeshop.json`; model = go-pflow `stochastic/testdata/coffeeshop.json` stripped to `id/initial/capacity`, `id/rate`, `from/to/weight` |
| timed.json | 53c7140c779bc7ce9dde590f2559a345e68cb547ebff0eff2e79da0a99fc3e28 | go-pflow `stochastic/testdata/portable/timed.json`; §5 delayed transitions, added after the five above |

Options per fixture (horizon, samples, realizations, seed): chain
`{10, 11, 3, 42}`, sir `{40, 81, 8, 11}`, dimer `{5, 21, 4, 7}`, gates
`{20, 41, 4, 5}`, coffeeshop `{8, 60, 5, 42}`, timed `{12, 25, 3, 9}`. `timed`
is the sixth: delayed transitions (§5 in go-pflow's
`stochastic/testdata/README.md` — a shared resource on a deterministic clock,
an infinite-server clock, priority over an exponential rival, and a horizon
that cuts firings mid-flight). `gates` is the fifth fixture
beyond the spec's four: read arc, inhibitor, non-kinetic input, capacity bound
and a self-loop on a full place — the §3.1/§3.3 branches the others never
reach.

Before the Go generator existed these files were produced by the spec's Python
reference; the Go output agreed with it on every parsed double, and the raw
bytes differ only in the `_comment` and in `100` vs `100.0` formatting. The
Python-derived files were replaced, never merged.

Verify the copies against go-pflow (and the sibling repos):

```bash
sha256sum parity/ssa/*.json ../go-pflow/stochastic/testdata/portable/*.json \
  ../pflow-jl/test/testdata/ssa/*.json
```
