"""load_theory: parse a .chyp file with Chyp's own parser and describe what is in it."""
from __future__ import annotations

import hashlib
import os
import re
from dataclasses import dataclass, field
from typing import Any

from . import _chyp
from ._chyp import (ApplyTacticPart, GenPart, Graph, LetPart, ProofQedPart,
                    RewritePart, RulePart, State, TheoremPart, graph_to_term)


@dataclass(frozen=True)
class ChypMessage:
    """One entry of Chyp's ``State.errors``: (file, line, message).

    ``phase`` is 'parse' for what the parser/State transformer logged (syntax
    errors, undefined names, type mismatches, duplicate definitions) and
    'check' for what ``chyp.checker.check`` logged (unknown rules, ...).
    ``line`` is Chyp's 1-based line number (-1 when Chyp gives none).
    """
    file: str
    line: int
    message: str
    phase: str

    def to_dict(self, theory: 'Theory | None' = None) -> dict[str, Any]:
        """As JSON; ``file`` is shown as the theory's display path when it is the
        theory's own file (or Chyp gave none), else ~- or cwd-relative."""
        if theory is not None and self.file in ('', theory.path):
            f = theory.source_display()
        else:
            f = _chyp.display_path(self.file) if self.file else ''
        return {'line': self.line, 'message': self.message, 'phase': self.phase, 'file': f}


@dataclass(frozen=True)
class Gen:
    """A generator ``gen name : dom -> cod``: one box with typed wires.

    ``domain``/``codomain`` are Chyp's lists of (type, register size); type None is
    Chyp's default (untyped) wire. ``signature`` is the type in Chyp's syntax.
    """
    name: str
    line: int
    domain: tuple[tuple[str | None, int], ...]
    codomain: tuple[tuple[str | None, int], ...]
    fg: str
    bg: str

    @property
    def arity(self) -> int:
        return len(self.domain)

    @property
    def coarity(self) -> int:
        return len(self.codomain)

    @property
    def signature(self) -> str:
        return f'{type_term(self.domain)} -> {type_term(self.codomain)}'

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            'name': self.name, 'line': self.line, 'signature': self.signature,
            'arity': self.arity, 'coarity': self.coarity,
            'domain': [wire_type(t, s) for t, s in self.domain],
            'codomain': [wire_type(t, s) for t, s in self.codomain]}
        if self.fg:
            d['fg'] = self.fg
        if self.bg:
            d['bg'] = self.bg
        return d


@dataclass(frozen=True)
class RuleInfo:
    """A rule as Chyp stores it. ``kind`` is the statement that made it: 'rule'
    (assumed), 'def' (``def x = t`` gives the rule ``x_def : x = t``) or 'show'.
    ``lhs``/``rhs`` are Chyp's ``graph_to_term`` of the two sides (normalised by
    Chyp, not the source text; ``text`` is the source statement)."""
    name: str
    line: int
    kind: str
    lhs: str
    rhs: str
    text: str

    def to_dict(self) -> dict[str, Any]:
        return {'name': self.name, 'line': self.line, 'kind': self.kind,
                'lhs': self.lhs, 'rhs': self.rhs, 'text': self.text}


@dataclass(frozen=True)
class By:
    """How a step is justified, from the RewritePart's tactic.

    tactic 'rule': one rule (``by r`` / ``by -r`` / ``by rule(r)``), ``rule`` is
    its name and ``direction`` 'forward' or 'converse' (the '-').
    tactic 'simp': ``rules`` are the rule arguments, ``flags`` the '+...' ones.
    tactic 'refl': a bare step (no ``by``); see KNOWN_ISSUES['bare-step'].
    """
    tactic: str
    args: tuple[str, ...]

    @property
    def text(self) -> str:
        if self.tactic == 'refl' and not self.args:
            return 'refl'
        return f'{self.tactic}({", ".join(self.args)})'

    @property
    def rule(self) -> str | None:
        if self.tactic == 'rule' and self.args:
            return self.args[0].strip().lstrip('-').strip()
        return None

    @property
    def direction(self) -> str | None:
        if self.tactic == 'rule' and self.args:
            return 'converse' if self.args[0].strip().startswith('-') else 'forward'
        return None

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {'tactic': self.tactic, 'text': self.text}
        if self.tactic == 'rule':
            d['rule'] = self.rule
            d['direction'] = self.direction
        elif self.tactic == 'simp':
            d['rules'] = [a.strip() for a in self.args if not a.strip().startswith('+')]
            flags = [a.strip() for a in self.args if a.strip().startswith('+')]
            if flags:
                d['flags'] = flags
        elif self.tactic == 'refl':
            d['bare'] = True
        return d


@dataclass(frozen=True)
class StepInfo:
    """One ``= term [by tactic]`` line of a rewrite, as parsed.

    ``term_before``/``term_after`` are Chyp's graph_to_term of the step's two
    graphs (None when Chyp could not build the term, or, inside a proof, before
    checking fills in LHS/RHS). ``text_before``/``text_after`` are the source.
    """
    rewrite: str
    step_index: int
    line: int
    by: By
    term_before: str | None
    term_after: str | None
    text_before: str | None
    text_after: str | None
    hole: bool

    def to_dict(self) -> dict[str, Any]:
        return {'step_index': self.step_index, 'line': self.line,
                'term_before': self.term_before, 'term_after': self.term_after,
                'text_before': self.text_before, 'text_after': self.text_after,
                'by': self.by.to_dict(), 'hole': self.hole}


@dataclass(frozen=True)
class RewriteInfo:
    """One ``rewrite`` statement (or one ``rewrite LHS|RHS`` block in a proof).

    ``name`` is Chyp's (with a leading '-' for ``rewrite -name``); rewrites in a
    proof have name '' in Chyp and are given ``in_proof_of`` (the theorem).
    ``line`` is the line of the ``rewrite`` keyword; each step has its own.
    """
    index: int
    name: str
    line: int
    in_proof_of: str | None
    stub: bool
    steps: tuple[StepInfo, ...]

    @property
    def label(self) -> str:
        if self.in_proof_of is not None:
            return f'(in proof of {self.in_proof_of})'
        return self.name

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {'index': self.index, 'name': self.name, 'line': self.line}
        if self.in_proof_of is not None:
            d['in_proof_of'] = self.in_proof_of
        if self.stub:
            d['stub'] = True
        d['steps'] = [s.to_dict() for s in self.steps]
        return d


@dataclass
class Theory:
    """A parsed .chyp theory.

    Everything here comes from ``chyp.parser.parse`` (a lark LALR grammar that
    feeds ``chyp.state.State``); nothing is checked yet (see ``check``).

    Attributes:
        name: the theory's name (``name=`` or the file's stem, else 'theory').
        path: absolute path of the source file, or None for text.
        source: the source text.
        sha256: hex SHA-256 of the source bytes (UTF-8 for text).
        gens, rules, rewrites, lets: what the file defines, in file order.
        theorems: names and lines of ``theorem``/``lemma``/``proposition``.
        errors: what Chyp logged while parsing, with line numbers. A syntax
            error stops Chyp's parser, so later statements are missing.
        state: the ``chyp.state.State`` (a Chyp object; use it read-only).
    """
    name: str
    path: str | None
    source: str
    sha256: str
    gens: list[Gen]
    rules: list[RuleInfo]
    rewrites: list[RewriteInfo]
    lets: list[dict[str, Any]]
    theorems: list[dict[str, Any]]
    errors: list[ChypMessage]
    state: State
    _cache: dict[str, Any] = field(default_factory=dict, repr=False, compare=False)

    @property
    def ok(self) -> bool:
        """True when Chyp logged nothing while parsing."""
        return not self.errors

    @property
    def file_name(self) -> str:
        """The file name handed to Chyp (used in its messages and for imports)."""
        return self.path or ''

    def source_display(self) -> str:
        return _chyp.display_path(self.path) if self.path else f'<text:{self.name}>'

    def summary(self) -> dict[str, int]:
        return {'gens': len(self.gens), 'rules': len(self.rules),
                'rewrites': len(self.rewrites),
                'steps': sum(len(r.steps) for r in self.rewrites),
                'theorems': len(self.theorems), 'errors': len(self.errors)}

    def to_dict(self) -> dict[str, Any]:
        disp = self.source_display()
        return {'name': self.name, 'source': disp, 'sha256': self.sha256,
                'gens': [g.to_dict() for g in self.gens],
                'rules': [r.to_dict() for r in self.rules],
                'lets': list(self.lets),
                'rewrites': [r.to_dict() for r in self.rewrites],
                'theorems': list(self.theorems),
                'errors': [e.to_dict(self) for e in self.errors]}

    def reparse(self) -> State:
        """A fresh Chyp State for the same source (checking mutates its State)."""
        return parse_state(self.source, self.file_name)[0]


# --- helpers -----------------------------------------------------------------

def wire_type(vtype: str | None, size: int) -> dict[str, Any]:
    d: dict[str, Any] = {'type': vtype}
    if size != 1:
        d['size'] = size
    return d


def type_term(lst: Any) -> str:
    """A domain/codomain in Chyp's syntax: '2' for two default wires, 'A * B^2',
    'None' for the monoidal unit (parser.py grammar: type_term)."""
    lst = list(lst)
    if not lst:
        return 'None'
    if all(t is None and s == 1 for t, s in lst):
        return str(len(lst))
    return ' * '.join(('u' if t is None else t) + ('' if s == 1 else f'^{s}') for t, s in lst)


def term_of(g: Graph | None) -> str | None:
    """Chyp's own term for a graph (chyp.term.graph_to_term), or None."""
    if g is None:
        return None
    try:
        return graph_to_term(g)
    except Exception as e:  # noqa: BLE001  (Chyp raises for graphs it cannot print)
        return f'<unprintable: {type(e).__name__}: {e}>'


def _squash(text: str) -> str:
    text = re.sub(r'#[^\n]*', '', text)
    return ' '.join(text.split())


_EQ_TOKENS = ('<=', '==', '~>', '=')


def _initial_text(source: str, start: int, t_start: int) -> str | None:
    """The source of a rewrite's first term: between 'rewrite name :' and the
    first step's '=' (Chyp keeps no position for it, so it is cut from the text)."""
    seg = _squash(source[start:t_start])
    m = re.match(r'rewrite\s+(LHS|RHS)\b', seg)
    if m:
        return m.group(1)
    m = re.match(r'rewrite\s+-?\s*[A-Za-z_][\w.]*\s*:(.*)$', seg, re.S)
    if not m:
        return None
    body = m.group(1).rstrip()
    for tok in _EQ_TOKENS:
        if body.endswith(tok):
            body = body[:-len(tok)]
            break
    return body.strip() or None


def line_of(source: str, pos: int) -> int:
    return source.count('\n', 0, max(0, pos)) + 1


def parse_state(source: str, file_name: str) -> tuple[State, str | None]:
    """Run chyp.parser.parse on source. Returns (state, exception text or None).

    Chyp catches lark's UnexpectedInput itself and logs it with a line number.
    Anything else raised inside its transformer is caught here and logged on
    an empty State, so a broken file never crashes the caller.
    """
    try:
        return _chyp.parser.parse(code=source, file_name=file_name), None
    except Exception as e:  # noqa: BLE001
        st = State('', file_name)
        line = -1
        obj = getattr(e, 'obj', None)  # lark.exceptions.VisitError
        meta = getattr(obj, 'meta', None)
        if meta is not None and not getattr(meta, 'empty', True):
            line = getattr(meta, 'line', -1)
        inner = getattr(e, 'orig_exc', e)
        st.errors.append((file_name, line, f'{type(inner).__name__}: {inner}'))
        return st, f'{type(inner).__name__}: {inner}'


def _statement_kind(source: str, pos: int) -> str:
    m = re.match(r'\s*(\w+)', source[pos:pos + 40])
    return m.group(1) if m else ''


def group_rewrites(state: State) -> list[list[RewritePart]]:
    """RewriteParts grouped into rewrite statements, in file order.

    A step continues the previous one when Chyp gave it the previous step's
    end as its start (state.py: ``start = end``) and the same name/sequence.
    """
    groups: list[list[RewritePart]] = []
    prev = None
    for p in state.parts:
        if isinstance(p, RewritePart):
            if (groups and isinstance(prev, RewritePart) and p.start == prev.end
                    and p.name == prev.name and p.sequence == prev.sequence and not p.stub):
                groups[-1].append(p)
            else:
                groups.append([p])
        prev = p
    return groups


def theorem_of(state: State) -> dict[int, str]:
    """part index -> name of the theorem whose proof the part is in."""
    out: dict[int, str] = {}
    current = None
    for p in state.parts:
        if isinstance(p, TheoremPart):
            current = p.name
        elif isinstance(p, (RewritePart, ApplyTacticPart)) and current is not None:
            out[p.index] = current
        if isinstance(p, ProofQedPart):
            current = None
    return out


def is_hole(source: str, p: RewritePart) -> bool:
    """A step written ``= ?`` (an unfilled hole). Read from the source: Chyp
    stores None as the rhs both for a hole and for a term it could not build,
    and its checker later replaces a hole's rhs by the lhs."""
    t_start, t_end = p.term_pos
    return not p.stub and source[t_start:t_end].strip() == '?'


def describe(state: State, source: str) -> dict[str, Any]:
    """gens, rules, lets, rewrites and theorems of a (parsed or checked) State."""
    gens: list[Gen] = []
    rules: list[RuleInfo] = []
    lets: list[dict[str, Any]] = []
    theorems: list[dict[str, Any]] = []
    for p in state.parts:
        if isinstance(p, GenPart):
            edata = next(iter(p.graph.edata.values()), None)
            gens.append(Gen(p.name, p.line, tuple(p.graph.domain()), tuple(p.graph.codomain()),
                            edata.fg if edata else '', edata.bg if edata else ''))
        elif isinstance(p, RulePart):
            kind = _statement_kind(source, p.start)
            rules.append(RuleInfo(p.name, p.line, kind if kind in ('rule', 'def', 'show') else 'rule',
                                  term_of(p.lhs) or '', term_of(p.rhs) or '',
                                  _squash(source[p.start:p.end])))
        elif isinstance(p, LetPart):
            lets.append({'name': p.name, 'line': p.line, 'term': term_of(p.graph)})
        elif isinstance(p, TheoremPart):
            theorems.append({'name': p.name, 'line': p.line,
                             'lhs': term_of(p.lhs), 'rhs': term_of(p.rhs)})
    owner = theorem_of(state)
    rewrites: list[RewriteInfo] = []
    for gi, group in enumerate(group_rewrites(state)):
        first = group[0]
        in_proof = owner.get(first.index) if first.name == '' else None
        if first.name == '' and in_proof is None:
            in_proof = '?'
        steps = []
        prev_text: str | None = None
        for i, p in enumerate(group):
            t_start, t_end = p.term_pos
            text_after = None if p.stub else (_squash(source[t_start:t_end]) or None)
            text_before = _initial_text(source, p.start, t_start) if i == 0 else prev_text
            if p.stub:
                text_before = _initial_text(source, p.start, p.end)
            hole = is_hole(source, p)
            steps.append(StepInfo(
                rewrite=first.name, step_index=i, line=p.line,
                by=By(p.tactic, tuple(p.tactic_args)),
                term_before=term_of(p.lhs), term_after=None if (hole or p.stub) else term_of(p.rhs),
                text_before=text_before, text_after='?' if hole else text_after, hole=hole))
            prev_text = text_after
        rewrites.append(RewriteInfo(index=gi, name=first.name, line=line_of(source, first.start),
                                    in_proof_of=in_proof, stub=first.stub, steps=tuple(steps)))
    return {'gens': gens, 'rules': rules, 'lets': lets, 'theorems': theorems,
            'rewrites': rewrites}


def load_theory(path_or_text: str | os.PathLike[str], *, name: str | None = None) -> Theory:
    """Parse a Chyp theory with Chyp's own parser (``chyp.parser.parse``).

    Args:
        path_or_text: a path to a .chyp file (str or PathLike), or the source
            text itself. A str is read as a path when it has no newline and
            names an existing file; otherwise it is the source (a one-line
            str ending in '.chyp' that names no file raises FileNotFoundError).
        name: the theory's name; default the file stem (or 'theory' for text).

    Returns a Theory: gens (name, arity/coarity, wire types), rules (name, lhs,
    rhs as Chyp terms), rewrites (name, steps), lets, theorems, and the errors
    Chyp logged while parsing, each with its line number. A file is read as
    UTF-8. ``import`` statements in the file are resolved by Chyp relative to
    the file (for text: relative to the current directory).
    """
    is_path = isinstance(path_or_text, os.PathLike) or (
        isinstance(path_or_text, str) and '\n' not in path_or_text
        and os.path.isfile(path_or_text))
    if (not is_path and isinstance(path_or_text, str) and '\n' not in path_or_text
            and path_or_text.strip().endswith('.chyp')):
        raise FileNotFoundError(f'no such .chyp file: {path_or_text}')
    if is_path:
        path: str | None = os.path.abspath(os.fspath(path_or_text))
        with open(path, 'rb') as f:
            raw = f.read()
        source = raw.decode('utf-8')
        default_name = os.path.splitext(os.path.basename(path))[0]
    else:
        path = None
        source = str(path_or_text)
        raw = source.encode('utf-8')
        default_name = 'theory'
    st, _exc = parse_state(source, path or '')
    errors = [ChypMessage(f, ln, m, 'parse') for (f, ln, m) in st.errors]
    d = describe(st, source)
    return Theory(name=name or default_name, path=path, source=source,
                  sha256=hashlib.sha256(raw).hexdigest(), errors=errors, state=st, **d)
