"""export: check + diagrams + provenance in one JSON document, and the page index."""
from __future__ import annotations

import datetime as _dt
import json
import os
import platform
from typing import Any, Iterable

from . import _chyp
from .checking import CheckReport, check
from .diagrams import diagrams
from .theory import Theory

FORMAT = 'chyp-headless/1'
INDEX_FORMAT = 'chyp-headless-index/1'

_probe: dict[str, Any] = {}


def generated_at(value: str | None = None) -> str:
    """ISO-8601 UTC time: ``value`` if given, else $SOURCE_DATE_EPOCH (the
    reproducible-builds convention), else now."""
    if value:
        return value
    epoch = os.environ.get('SOURCE_DATE_EPOCH')
    t = (_dt.datetime.fromtimestamp(int(epoch), _dt.timezone.utc) if epoch
         else _dt.datetime.now(_dt.timezone.utc))
    return t.replace(microsecond=0).isoformat().replace('+00:00', 'Z')


def _dist_version(*names: str) -> str | None:
    try:
        from importlib import metadata
    except ImportError:  # pragma: no cover
        return None
    for n in names:
        try:
            return metadata.version(n)
        except Exception:  # noqa: BLE001
            continue
    return None


def layout_solver() -> dict[str, Any]:
    """cvxpy's installed solvers and the one it picks by default for a small L1
    problem of the form chyp.layout.convex_layout solves (a probe: Chyp calls
    problem.solve() with no solver, so this is what decides its coordinates)."""
    if 'solver' not in _probe:
        try:
            import cvxpy as cp
            x = cp.Variable(2)
            prob = cp.Problem(cp.Minimize(cp.norm1(x)), [x[1] - x[0] >= 1])
            prob.solve()
            _probe['solver'] = {'default_lp_solver': prob.solver_stats.solver_name,
                                'installed': sorted(cp.installed_solvers())}
        except Exception as e:  # noqa: BLE001
            _probe['solver'] = {'error': f'{type(e).__name__}: {e}'}
        _chyp.assert_headless()
    return _probe['solver']


def provenance(theory: Theory | None = None, *, layout_used: str | None = None,
               at: str | None = None) -> dict[str, Any]:
    """Where an export came from: Chyp's commit and version, the Python, lark and
    cvxpy versions, the source file and its SHA-256, and the time."""
    import lark
    d: dict[str, Any] = {
        'generator': f'chyp_headless {_version()}',
        'chyp': {'commit': _chyp.chyp_commit(), 'version': _chyp.chyp_version(),
                 'path': _chyp.display_path(_chyp.CHYP_PATH), 'url': _chyp.CHYP_URL,
                 'license': _chyp.CHYP_LICENSE, 'copyright': _chyp.CHYP_COPYRIGHT,
                 'modules': _chyp.chyp_modules()},
        'python': platform.python_version(),
        'python_implementation': platform.python_implementation(),
        'lark': getattr(lark, '__version__', None),
        'cvxpy': _dist_version('cvxpy', 'cvxpy-base'),
    }
    if layout_used == 'chyp':
        d['layout_solver'] = layout_solver()
    if theory is not None:
        d['source'] = {'path': theory.source_display(), 'sha256': theory.sha256,
                       'bytes': len(theory.source.encode('utf-8')),
                       'lines': theory.source.count('\n') + (0 if theory.source.endswith('\n') else 1)}
    d['generated_at'] = generated_at(at)
    return d


def _version() -> str:
    from . import __version__
    return __version__


def export(theory: Theory, *, layout: str = 'chyp', expect_fail: Iterable[str] = (),
           precision: int | None = 3, at: str | None = None) -> dict[str, Any]:
    """check + diagrams + provenance for one theory, as one JSON-serialisable dict:

        {format, name, provenance, theory: {gens, rules, lets, theorems, errors},
         check: CheckReport.to_dict(), diagrams: diagrams(...)}

    check.rewrites[i].steps[j] and diagrams.rewrites[i].steps[j] describe the
    same step. ``at`` fixes provenance.generated_at (else $SOURCE_DATE_EPOCH or
    now); nothing else in the document depends on the time or the machine's
    paths outside the cwd and home.
    """
    report: CheckReport = check(theory, expect_fail=expect_fail)
    dg = diagrams(theory, layout=layout, precision=precision, report=report)
    t = theory.to_dict()
    return {
        'format': FORMAT,
        'name': theory.name,
        'provenance': provenance(theory, layout_used=dg['layout']['used'], at=at),
        'theory': {k: t[k] for k in ('gens', 'rules', 'lets', 'theorems', 'errors')},
        'check': report.to_dict(),
        'diagrams': dg,
    }


def index(exports: list[dict[str, Any]], files: list[str], *, at: str | None = None) -> dict[str, Any]:
    """The page's index of exported theories, with status counts."""
    first = exports[0]['provenance'] if exports else provenance(at=at)
    return {
        'format': INDEX_FORMAT,
        'generated_at': generated_at(at),
        'generator': first['generator'],
        'chyp': {k: first['chyp'][k] for k in ('commit', 'version', 'url', 'license', 'copyright')},
        'python': first['python'], 'lark': first['lark'], 'cvxpy': first['cvxpy'],
        'layout': exports[0]['diagrams']['layout']['used'] if exports else None,
        'ok': all(e['check']['ok'] for e in exports),
        'theories': [{
            'name': e['name'], 'file': f, 'source': e['provenance']['source']['path'],
            'sha256': e['provenance']['source']['sha256'], 'ok': e['check']['ok'],
            'counts': e['check']['summary'],
            'flagged': [i['id'] for i in e['check']['known_issues']],
        } for e, f in zip(exports, files)],
    }


def dumps(obj: Any, width: int = 120) -> str:
    """Deterministic, compact but diffable JSON: keys in the order they were
    built (a fixed order), any object or array that fits in ``width`` columns
    on one line, everything else one entry per line with a one-space indent.
    UTF-8, trailing newline. json.loads gives back exactly ``obj``."""
    def flat(o: Any) -> str:
        return json.dumps(o, ensure_ascii=False, separators=(',', ':'))

    def enc(o: Any, ind: int, used: int) -> str:
        f = flat(o)
        if not isinstance(o, (dict, list)) or not o or used + len(f) <= width:
            return f
        pad = ' ' * (ind + 1)
        if isinstance(o, dict):
            rows = []
            for k, v in o.items():
                key = flat(str(k)) + ':'
                rows.append(pad + key + enc(v, ind + 1, len(pad) + len(key)))
            return '{\n' + ',\n'.join(rows) + '\n' + ' ' * ind + '}'
        return ('[\n' + ',\n'.join(pad + enc(v, ind + 1, len(pad)) for v in o)
                + '\n' + ' ' * ind + ']')

    return enc(obj, 0, 0) + '\n'


def write_json(obj: Any, path: str) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(dumps(obj))
