"""check: run Chyp's own checker on a theory and report every step's verdict."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable

from . import _chyp
from ._chyp import (ApplyTacticPart, Goal, Part, ProofState, RewritePart, Rule,
                    State, TheoremPart, find_iso, get_tactic)
from .theory import ChypMessage, Theory, describe, group_rewrites, parse_state, term_of

CHYP_STATUS = {Part.UNCHECKED: 'UNCHECKED', Part.CHECKING: 'CHECKING',
               Part.VALID: 'VALID', Part.INVALID: 'INVALID'}

BARE_STEP = 'chyp-3d28483-bare-step'

KNOWN_ISSUES: dict[str, dict[str, Any]] = {
    BARE_STEP: {
        'id': BARE_STEP,
        'summary': ("A bare rewrite step (no 'by': Chyp's refl tactic) is never VALID at "
                    "Chyp 3d28483, even when its two sides are the same diagram. "
                    "Tactic.run returns validate_goal() != None without popping the goal, "
                    "and checker.check marks a step VALID only when the number of goals "
                    "drops. The status reported is Chyp's verdict; 'diagnostics.find_iso' "
                    "says whether Chyp's find_iso does find an isomorphism."),
        'refs': ['chyp/tactic/__init__.py:99-100', 'chyp/proofstate.py:263-270',
                 'chyp/checker.py:99-104', 'chyp/RESULTS.md, "What did not work" item 1'],
        'workaround': "close such a step 'by simp()' (SimpTac.run ends in try_close_goal)",
    },
}


@dataclass
class StepResult:
    """Chyp's verdict on one rewrite step.

    status: 'valid'   Chyp's checker set the step's Part.status to VALID and
                      logged no message on its line;
            'invalid' Part.status INVALID (the tactic ran and did not close the
                      goal) and no message on its line;
            'error'   Chyp logged a message on the step's line (undefined rule
                      or term, type mismatch, unknown tactic, ...), or the step
                      was not checked (no steps, checker stopped by an exception).
    chyp_status is Part.status itself: VALID, INVALID, UNCHECKED or CHECKING.
    flags name known Chyp behaviours that explain the verdict (KNOWN_ISSUES).
    """
    rewrite: str
    rewrite_index: int
    step_index: int
    line: int
    term_before: str | None
    term_after: str | None
    text_before: str | None
    text_after: str | None
    by: dict[str, Any]
    status: str
    chyp_status: str
    messages: list[str]
    hole: bool = False
    flags: list[str] = field(default_factory=list)
    diagnostics: dict[str, Any] = field(default_factory=dict)
    note: str | None = None

    @property
    def message(self) -> str:
        return '; '.join(self.messages)

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            'rewrite': self.rewrite, 'rewrite_index': self.rewrite_index,
            'step_index': self.step_index, 'line': self.line,
            'term_before': self.term_before, 'term_after': self.term_after,
            'text_before': self.text_before, 'text_after': self.text_after,
            'by': self.by, 'status': self.status, 'chyp_status': self.chyp_status,
            'message': self.message, 'messages': list(self.messages)}
        if self.hole:
            d['hole'] = True
        if self.flags:
            d['flags'] = list(self.flags)
        if self.diagnostics:
            d['diagnostics'] = dict(self.diagnostics)
        if self.note:
            d['note'] = self.note
        return d


@dataclass
class RewriteResult:
    """A rewrite statement: its steps, what was expected, what Chyp decided.

    expected is 'invalid' for a negative control (name starting 'NOT_' or listed
    in expect_fail), else 'valid'. status is 'valid' when every step is valid,
    'error' when any step is an error, else 'invalid'. as_expected follows
    tools/chyp/check.py: an intended rewrite must be valid, a negative control
    must not be.
    """
    index: int
    name: str
    label: str
    line: int
    in_proof_of: str | None
    expected: str
    status: str
    steps: list[StepResult]

    @property
    def as_expected(self) -> bool:
        return (self.status == 'valid') == (self.expected == 'valid')

    @property
    def first_step_line(self) -> int:
        return self.steps[0].line if self.steps else self.line

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {'index': self.index, 'name': self.name, 'label': self.label,
                             'line': self.line, 'first_step_line': self.first_step_line}
        if self.in_proof_of is not None:
            d['in_proof_of'] = self.in_proof_of
        d.update({'expected': self.expected, 'status': self.status,
                  'as_expected': self.as_expected,
                  'steps': [s.to_dict() for s in self.steps]})
        return d


def _status(p: Part, msgs: list[str]) -> str:
    st = {Part.VALID: 'valid', Part.INVALID: 'invalid'}.get(p.status, 'error')
    return 'error' if msgs else st


@dataclass
class CheckReport:
    """What Chyp's checker (``chyp.checker.check``) decided for a theory.

    rewrites: one RewriteResult per rewrite statement, in file order (rewrite
        blocks inside a proof are listed too, with in_proof_of).
    theorems: [{name, line, status, chyp_status, messages, expected, applies}]
        where applies are the proof's ``apply`` steps with their own status.
    errors: every message Chyp logged ([{file, line, message, phase}]).
    type_warnings: a lint of this package, not Chyp's: in a file that declares
        typed wires, a rule or proved rewrite with an untyped wire (Chyp 3d28483
        can silently fix an inferred wire to the default type, graph.py:894-905).
    exception: set when chyp.checker.check raised; parts after it stay UNCHECKED.
    ok: no parse error, no exception, no type warning, every intended rewrite
        valid, no negative control valid, every theorem and apply valid (unless
        named in expect_fail). The CLI's exit status is 0 exactly when ok.
    state: the checked chyp.state.State (a Chyp object; read-only use).
    """
    theory: Theory
    rewrites: list[RewriteResult]
    theorems: list[dict[str, Any]]
    errors: list[ChypMessage]
    type_warnings: list[str]
    typed: bool
    exception: dict[str, Any] | None
    expect_fail: tuple[str, ...]
    state: State = field(repr=False)
    parts: dict[tuple[int, int], RewritePart] = field(repr=False, default_factory=dict)

    @property
    def steps(self) -> list[StepResult]:
        return [s for rw in self.rewrites for s in rw.steps]

    @property
    def parse_errors(self) -> list[ChypMessage]:
        return [e for e in self.errors if e.phase == 'parse']

    @property
    def ok(self) -> bool:
        if self.exception or self.parse_errors or self.type_warnings:
            return False
        if not all(rw.as_expected for rw in self.rewrites):
            return False
        for th in self.theorems:
            if th['status'] != 'valid' and th['name'] not in self.expect_fail:
                return False
            if any(a['status'] != 'valid' for a in th['applies']):
                return False
        return True

    def summary(self) -> dict[str, int]:
        intended = [r for r in self.rewrites if r.expected == 'valid']
        controls = [r for r in self.rewrites if r.expected != 'valid']
        steps = self.steps
        return {
            'rewrites': len(self.rewrites),
            'intended': len(intended),
            'intended_valid': sum(r.status == 'valid' for r in intended),
            'negative_controls': len(controls),
            'negative_controls_failed': sum(r.status != 'valid' for r in controls),
            'negative_controls_errored': sum(r.status == 'error' for r in controls),
            'steps': len(steps),
            'steps_valid': sum(s.status == 'valid' for s in steps),
            'steps_invalid': sum(s.status == 'invalid' for s in steps),
            'steps_error': sum(s.status == 'error' for s in steps),
            'steps_flagged': sum(bool(s.flags) for s in steps),
            'theorems': len(self.theorems),
            'theorems_valid': sum(t['status'] == 'valid' for t in self.theorems),
            'errors': len(self.errors),
        }

    def known_issues(self) -> list[dict[str, Any]]:
        out = []
        for key, issue in KNOWN_ISSUES.items():
            hits = [{'rewrite': s.rewrite, 'step_index': s.step_index, 'line': s.line}
                    for s in self.steps if key in s.flags]
            if hits:
                out.append({**issue, 'steps': hits})
        return out

    def to_dict(self) -> dict[str, Any]:
        disp = self.theory.source_display()
        return {
            'theory': self.theory.name, 'source': disp, 'ok': self.ok,
            'summary': self.summary(),
            'rewrites': [r.to_dict() for r in self.rewrites],
            'theorems': self.theorems,
            'errors': [e.to_dict(self.theory) for e in self.errors],
            'typed': self.typed,
            'type_warnings': list(self.type_warnings),
            'exception': self.exception,
            'known_issues': self.known_issues(),
        }


def _messages_on(state: State, file_name: str, line: int) -> list[str]:
    # the same attribution tools/chyp/check.py used: same line, same (or no) file
    return [m for (f, ln, m) in state.errors if ln == line and (f == file_name or not f)]


def _type_lint(state: State) -> tuple[bool, list[str]]:
    typed = any(vd.vtype is not None for g in state.graphs.values() for vd in g.vdata.values())
    warnings: list[str] = []
    if typed:
        for name, rule in state.rules.items():
            if name == 'refl':
                continue
            for side, g in (('lhs', rule.lhs), ('rhs', rule.rhs)):
                bad = [v for v in g.vertices() if g.vertex_data(v).vtype is None]
                if bad:
                    warnings.append(f'{name}.{side}: {len(bad)} untyped wire(s) in a typed file')
    return typed, warnings


def check(theory: Theory, *, expect_fail: Iterable[str] = ()) -> CheckReport:
    """Check every rewrite step and theorem of ``theory`` with Chyp's checker.

    The source is parsed again into a fresh Chyp State (checking mutates it)
    and ``chyp.checker.check(state)`` is run once, exactly as Chyp's editor does
    (gui/editor.py:349). Each step's verdict is the ``Part.status`` Chyp set,
    plus the messages Chyp logged on that line; nothing is re-implemented.

    Known Chyp 3d28483 behaviour: a bare step (no ``by``) is never VALID. It is
    reported as Chyp's verdict ('invalid'), flagged 'chyp-3d28483-bare-step',
    with diagnostics.find_iso telling whether the sides are isomorphic.

    Args:
        expect_fail: rewrite or theorem names that are negative controls, in
            addition to every rewrite named NOT_*.
    Returns a CheckReport (cached on the theory per expect_fail).
    """
    key = 'check:' + '\0'.join(sorted(set(expect_fail)))
    if key in theory._cache:
        return theory._cache[key]
    xf = tuple(sorted(set(expect_fail)))
    fname = theory.file_name
    state, _ = parse_state(theory.source, fname)
    n_parse = len(state.errors)
    exception = None
    try:
        _chyp.checker.check(state)
    except Exception as e:  # noqa: BLE001  (Chyp raises e.g. NotImplementedError from dpo)
        stuck = next((p for p in state.parts if p.status == Part.CHECKING), None)
        exception = {'type': type(e).__name__, 'message': str(e),
                     'line': stuck.line if stuck is not None else None}
    errors = [ChypMessage(f, ln, m, 'parse' if i < n_parse else 'check')
              for i, (f, ln, m) in enumerate(state.errors)]

    info = describe(state, theory.source)['rewrites']
    groups = group_rewrites(state)
    rewrites: list[RewriteResult] = []
    parts: dict[tuple[int, int], RewritePart] = {}
    for rinfo, group in zip(info, groups):
        steps: list[StepResult] = []
        for sinfo, p in zip(rinfo.steps, group):
            msgs = _messages_on(state, fname, p.line)
            if p.stub:
                status, msgs = 'error', msgs + ['rewrite has no steps']
            else:
                status = _status(p, msgs)
            sr = StepResult(
                rewrite=rinfo.label, rewrite_index=rinfo.index, step_index=sinfo.step_index,
                line=p.line, term_before=sinfo.term_before, term_after=sinfo.term_after,
                text_before=sinfo.text_before, text_after=sinfo.text_after,
                by=sinfo.by.to_dict(), status=status, chyp_status=CHYP_STATUS.get(p.status, str(p.status)),
                messages=msgs, hole=sinfo.hole)
            if sinfo.hole:
                sr.note = "unfilled hole ('= ?'): Chyp checks the lhs against itself"
            if (p.tactic == 'refl' and not p.tactic_args and not p.stub
                    and p.status == Part.INVALID):
                sr.flags.append(BARE_STEP)
                if p.lhs is not None and p.rhs is not None:
                    iso = find_iso(p.lhs, p.rhs) is not None
                    sr.diagnostics['find_iso'] = iso
                    sr.note = ("Chyp's verdict: INVALID. Chyp 3d28483 never closes a bare step; "
                               + ('find_iso finds an isomorphism, so the two sides are the same diagram.'
                                  if iso else 'find_iso finds no isomorphism either.'))
            steps.append(sr)
            parts[(rinfo.index, sinfo.step_index)] = p
        statuses = [s.status for s in steps]
        rw_status = ('valid' if statuses and all(s == 'valid' for s in statuses)
                     else 'error' if 'error' in statuses or not statuses else 'invalid')
        expected = ('invalid' if rinfo.name.startswith('NOT_') or rinfo.name in xf
                    or rinfo.label in xf else 'valid')
        rewrites.append(RewriteResult(index=rinfo.index, name=rinfo.name, label=rinfo.label,
                                      line=rinfo.line, in_proof_of=rinfo.in_proof_of,
                                      expected=expected, status=rw_status, steps=steps))

    theorems: list[dict[str, Any]] = []
    for p in state.parts:
        if isinstance(p, TheoremPart):
            msgs = _messages_on(state, fname, p.line)
            theorems.append({'name': p.name, 'line': p.line, 'lhs': term_of(p.lhs),
                             'rhs': term_of(p.rhs), 'status': _status(p, msgs),
                             'chyp_status': CHYP_STATUS.get(p.status, str(p.status)),
                             'messages': msgs,
                             'expected': 'invalid' if p.name in xf else 'valid',
                             'applies': []})
        elif isinstance(p, ApplyTacticPart) and theorems:
            msgs = _messages_on(state, fname, p.line)
            theorems[-1]['applies'].append({
                'line': p.line, 'by': p.tactic + '(' + ', '.join(p.tactic_args) + ')',
                'status': _status(p, msgs),
                'chyp_status': CHYP_STATUS.get(p.status, str(p.status)), 'messages': msgs})

    typed, warnings = _type_lint(state)
    report = CheckReport(theory=theory, rewrites=rewrites, theorems=theorems, errors=errors,
                         type_warnings=warnings, typed=typed, exception=exception,
                         expect_fail=xf, state=state, parts=parts)
    theory._cache[key] = report
    return report


def suggest(report: CheckReport, step: StepResult | int, *, limit: int = 8) -> list[str]:
    """The distinct terms one application of a step's tactic gives on its lhs
    (what Chyp's GUI cycles through with CTRL+N: Tactic.make_rhs). ``step`` is a
    StepResult of this report or a step's line number. Authoring aid; never
    changes a verdict, and messages Chyp logs meanwhile are discarded."""
    state = report.state
    if isinstance(step, StepResult):
        p = report.parts.get((step.rewrite_index, step.step_index))
    else:
        p = next((q for q in report.parts.values() if q.line == step), None)
    if p is None or p.lhs is None:
        return []
    n = len(state.errors)
    out: list[str] = []
    try:
        ps = ProofState(state, p.sequence, [Goal(Rule(p.lhs.copy(), p.lhs.copy()))])
        t = get_tactic(ps, p.tactic, p.tactic_args)
        for g in t.make_rhs():
            s = term_of(g)
            if s is not None and s not in out:
                out.append(s)
            if len(out) >= limit:
                break
    except (RuntimeError, StopIteration):
        pass
    finally:
        del state.errors[n:]
    return out
