# Roadmap

## Guided modelling and simulation in the browser

**Problem.** The editor can simulate, but only if you already know what you
are doing. Choosing an engine (ODE, SSA, SDE), setting rates, picking a time
span and reading the plots all assume you know the formalism. For someone who
arrives with a question rather than a net, simulation is barely usable.

**Goal.** Provide in the editor the kind of service
[sim.pflow.xyz](https://sim.pflow.xyz) provides: help developing a model and
running it, so the result is something a newcomer can act on and trust.

Directions to consider:

- **Start from a question, not a canvas.** Describe the process in words and
  get a first net to edit, as sim does from a description.
- **Sensible defaults.** Pick the engine, rates, horizon and seed for the
  model, and say what was chosen and why. Hide the solver options until asked.
- **Seeded, repeatable scenarios.** One click to run a what-if and get the same
  answer next time, with the spread shown rather than a single trajectory.
- **Say which knobs matter.** Rank parameters by measured effect on an outcome,
  and flag the ones that do nothing.
- **Check the model before running it.** Surface structural problems (deadlock,
  unbounded places, unconnected nodes) in plain language.
- **Plain-language results.** Answer the question asked, with the evidence
  behind it, before showing plots.
- **Share with sim.** Open the same net on sim.pflow.xyz, or store it there,
  without re-entering it.

Open questions: how much of this runs client-side (the browser engines are
byte-exact to go-pflow) versus calling sim; and how the guided flow coexists
with the current expert-facing Analysis dialog.
