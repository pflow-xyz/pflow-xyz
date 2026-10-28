"""Command line: python -B -m chyp_headless {check,diagrams,export} FILE... [options]

    check      run Chyp's checker; a table of every rewrite step (default) or JSON
    diagrams   every gen/rule/step as a hypergraph (summary table, or JSON)
    export     check + diagrams + provenance (summary table, or JSON)

Options:
    --json            print JSON instead of the table
    --out PATH        also write JSON: PATH ending in .json gets one document
                      (several FILEs: {"theories": [...]}); any other PATH is a
                      directory that gets <stem>.json per FILE, plus index.json
                      for export
    --layout chyp|none   coordinates from Chyp's convex_layout (default; needs
                      cvxpy) or topology only
    --precision N     decimals for coordinates (default 3)
    --expect-fail NAME   a rewrite/theorem that is a negative control (repeatable;
                      rewrites named NOT_* always are)
    --generated-at T  fix provenance.generated_at (else $SOURCE_DATE_EPOCH, else now)

Exit status: 0 when every FILE is ok (every intended rewrite checks, no negative
control checks, no parse error), 1 otherwise, 2 for usage errors.
"""
from __future__ import annotations

import argparse
import os
import platform
import sys
from typing import Any

from . import __version__, _chyp
from .checking import CheckReport, check
from .diagrams import diagrams
from .exporting import dumps, export, index, write_json
from .theory import Theory, load_theory


def _banner() -> str:
    import lark
    return (f'chyp_headless {__version__}: Chyp {_chyp.chyp_commit()[:7]} at '
            f'{_chyp.display_path(_chyp.CHYP_PATH)}; Python {platform.python_version()}, '
            f'lark {lark.__version__}')


def _cell(s: Any, n: int) -> str:
    s = str(s)
    return s if len(s) <= n else s[:n - 1] + '~'


def format_check(r: CheckReport) -> str:
    """The human-readable table for one CheckReport."""
    s = r.summary()
    out = [f'== {r.theory.source_display()}: {"OK" if r.ok else "NOT OK"}   '
           f'rewrites {s["intended_valid"]}/{s["intended"]} valid'
           + (f', negative controls {s["negative_controls_failed"]}/{s["negative_controls"]} failed'
              if s['negative_controls'] else '')
           + f'; steps {s["steps"]}: {s["steps_valid"]} valid, {s["steps_invalid"]} invalid, '
           f'{s["steps_error"]} error'
           + (f'; {s["theorems_valid"]}/{s["theorems"]} theorems valid' if s['theorems'] else '')]
    for e in r.parse_errors:
        out.append(f'   PARSE/STATE ERROR line {e.line}: {e.message}')
    if r.exception:
        out.append(f'   CHECKER EXCEPTION (line {r.exception["line"]}): '
                   f'{r.exception["type"]}: {r.exception["message"]}')
    for w in r.type_warnings:
        out.append(f'   TYPE WARNING: {w}')
    if r.rewrites:
        out.append(f'   {"rewrite":<34} {"line":>4} {"#":>2}  {"by":<30} {"status":<8} note')
    for rw in r.rewrites:
        for st in rw.steps:
            name = rw.label if st.step_index == 0 else ''
            note = ''
            if st.step_index == len(rw.steps) - 1:
                if rw.expected != 'valid':
                    note = ('negative control, failed as it should' if rw.as_expected
                            else 'NEGATIVE CONTROL CHECKED')
                elif not rw.as_expected:
                    note = f'REWRITE {rw.status.upper()}'
            if st.flags:
                note = (note + '; ' if note else '') + ', '.join(st.flags) + (
                    f' (find_iso {"FOUND" if st.diagnostics.get("find_iso") else "found no"} iso)'
                    if 'find_iso' in st.diagnostics else '')
            out.append(f'   {_cell(name, 34):<34} {st.line:>4} {st.step_index:>2}  '
                       f'{_cell(st.by["text"], 30):<30} {st.status:<8} {note}'.rstrip())
            for m in st.messages:
                out.append(f'   {"":<34} {"":>4} {"":>2}  message: {m}')
    for th in r.theorems:
        out.append(f'   theorem {th["name"]} (line {th["line"]}): {th["status"]}')
        for a in th['applies']:
            out.append(f'      apply {a["by"]} (line {a["line"]}): {a["status"]}')
    for issue in r.known_issues():
        out.append(f'   known Chyp behaviour {issue["id"]}: {len(issue["steps"])} step(s); '
                   f'Chyp\'s verdict is reported unchanged (see KNOWN_ISSUES)')
    return '\n'.join(out)


def _diagram_summary(d: dict[str, Any], th: Theory) -> str:
    n_graphs = len(d['gens']) + 2 * len(d['rules']) + sum(len(r['graphs']) for r in d['rewrites'])
    steps = [s for r in d['rewrites'] for s in r['steps']]
    matched = sum(s['match'] is not None for s in steps)
    lay = d['layout']
    return (f'== {th.source_display()}: {n_graphs} diagrams ({len(d["gens"])} gens, '
            f'{len(d["rules"])} rules x 2, {sum(len(r["graphs"]) for r in d["rewrites"])} rewrite '
            f'graphs for {len(steps)} steps); layout {lay["used"]}'
            + (f' ({lay["reason"]})' if 'reason' in lay else '')
            + f'; {matched}/{len(steps)} steps with a match')


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog='python -B -m chyp_headless',
                                 description='Headless API over Chyp (check, diagrams, export).')
    ap.add_argument('command', choices=('check', 'diagrams', 'export'))
    ap.add_argument('files', nargs='+', metavar='FILE')
    ap.add_argument('--json', action='store_true', help='print JSON instead of a table')
    ap.add_argument('--out', help='write JSON here (.json file, or a directory)')
    ap.add_argument('--layout', choices=('chyp', 'none'), default='chyp')
    ap.add_argument('--precision', type=int, default=3)
    ap.add_argument('--expect-fail', action='append', default=[], metavar='NAME')
    ap.add_argument('--generated-at', default=None, metavar='ISO8601')
    a = ap.parse_args(argv)

    theories: list[Theory] = []
    for f in a.files:
        if not os.path.isfile(f):
            ap.error(f'no such file: {f}')  # a usage error: exit status 2
        try:
            theories.append(load_theory(f))
        except (OSError, UnicodeDecodeError) as e:
            ap.error(f'cannot read {f}: {e}')
    reports = [check(t, expect_fail=a.expect_fail) for t in theories]
    docs: list[dict[str, Any]] = []
    if a.command == 'check':
        docs = [r.to_dict() for r in reports]
    elif a.command == 'diagrams':
        docs = [diagrams(t, layout=a.layout, precision=a.precision, report=r)
                for t, r in zip(theories, reports)]
    else:
        docs = [export(t, layout=a.layout, expect_fail=a.expect_fail, precision=a.precision,
                       at=a.generated_at) for t in theories]

    if a.json:
        sys.stdout.write(dumps(docs[0] if len(docs) == 1 else {'theories': docs}))
    else:
        print(_banner())
        for t, r, d in zip(theories, reports, docs):
            print(format_check(r) if a.command == 'check' else
                  format_check(r) + '\n' + _diagram_summary(
                      d if a.command == 'diagrams' else d['diagrams'], t))
    if a.out:
        if a.out.endswith('.json'):
            write_json(docs[0] if len(docs) == 1 else {'theories': docs}, a.out)
            written = [a.out]
        else:
            written = []
            for t, d in zip(theories, docs):
                p = os.path.join(a.out, t.name + '.json')
                write_json(d, p)
                written.append(p)
            if a.command == 'export':
                p = os.path.join(a.out, 'index.json')
                write_json(index(docs, [t.name + '.json' for t in theories], at=a.generated_at), p)
                written.append(p)
        if not a.json:
            for p in written:
                print(f'wrote {p}')
    ok = all(r.ok for r in reports)
    if not a.json:
        print(f'ALL: {"OK" if ok else "NOT OK"} ({len(reports)} file(s))')
    return 0 if ok else 1


if __name__ == '__main__':  # pragma: no cover
    sys.exit(main())
