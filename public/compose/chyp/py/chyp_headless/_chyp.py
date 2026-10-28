"""Locate Chyp, import its headless core, and refuse any GUI import.

Chyp (https://github.com/akissinger/chyp) is Copyright (C) 2022-2023 Aleks
Kissinger and licensed under the Apache License 2.0. This module imports it from
a checkout that it never writes to. No Chyp code is copied here.

Where Chyp is: ``$CHYP_PATH``, else ``$CHYP_ROOT`` (the name tools/chyp/run.sh
uses), else ``~/Workspace/chyp``. That directory is put first on ``sys.path``.
``sys.dont_write_bytecode`` is set to True *before* any Chyp module is imported,
so Python does not write ``__pycache__`` into the checkout. Run with ``python -B``
and ``PYTHONDONTWRITEBYTECODE=1`` as well.

Chyp modules this package imports (Chyp 3d28483):

    directly      chyp.parser, chyp.state, chyp.checker, chyp.parts,
                  chyp.term, chyp.matcher, chyp.proofstate, chyp.rule,
                  chyp.graph, chyp.tactic
    transitively  chyp (package __init__, a licence header only),
                  chyp.rewrite (via chyp.proofstate),
                  chyp.tactic.ruletac, chyp.tactic.simptac (chyp.tactic.get_tactic
                  imports them lazily; _import_core imports them up front)
    on demand     chyp.layout, only by diagrams(layout='chyp'); it imports cvxpy

Never imported: chyp.__main__, chyp.gui.* (the only modules that import PySide6)
and chyp.scraps. ``assert_headless()`` checks this after every import.
"""
from __future__ import annotations

import os
import re
import sys
from typing import Any

# Before anything imports Chyp: no bytecode files in the read-only checkout.
sys.dont_write_bytecode = True

DEFAULT_CHYP_PATH = '~/Workspace/chyp'
CHYP_URL = 'https://github.com/akissinger/chyp'
CHYP_LICENSE = 'Apache-2.0'
CHYP_COPYRIGHT = 'Copyright (C) 2022-2023 Aleks Kissinger'

GUI_PREFIXES = ('PySide6', 'PySide2', 'PyQt', 'shiboken', 'chyp.gui', 'chyp.__main__')

# What load/check import (see the module docstring). chyp.layout is extra.
CORE_MODULES = (
    'chyp', 'chyp.checker', 'chyp.graph', 'chyp.matcher', 'chyp.parser',
    'chyp.parts', 'chyp.proofstate', 'chyp.rewrite', 'chyp.rule', 'chyp.state',
    'chyp.tactic', 'chyp.tactic.ruletac', 'chyp.tactic.simptac', 'chyp.term',
)
LAYOUT_MODULES = ('chyp.layout',)


def chyp_path() -> str:
    """The Chyp checkout in use: $CHYP_PATH, else $CHYP_ROOT, else ~/Workspace/chyp."""
    raw = os.environ.get('CHYP_PATH') or os.environ.get('CHYP_ROOT') or DEFAULT_CHYP_PATH
    return os.path.abspath(os.path.expanduser(raw))


CHYP_PATH = chyp_path()


def gui_modules() -> list[str]:
    """Names of loaded modules that belong to a GUI toolkit or to chyp.gui."""
    return sorted(m for m in list(sys.modules)
                  if any(m == p or m.startswith(p) for p in GUI_PREFIXES))


def assert_headless() -> None:
    """Raise ImportError if any Qt binding or chyp.gui module has been imported."""
    bad = gui_modules()
    if bad:
        raise ImportError('chyp_headless must stay headless, but these GUI modules '
                          'are loaded: ' + ', '.join(bad))


def _import_core() -> Any:
    if not os.path.isfile(os.path.join(CHYP_PATH, 'chyp', '__init__.py')):
        raise ImportError(f'Chyp not found at {CHYP_PATH} (no chyp/__init__.py there); '
                          'set CHYP_PATH to a Chyp checkout')
    if CHYP_PATH not in sys.path:
        sys.path.insert(0, CHYP_PATH)
    import chyp  # noqa: F401
    from chyp import checker, graph, matcher, parser, parts, proofstate, rule, state, term  # noqa: F401
    from chyp import tactic  # noqa: F401
    from chyp.tactic import ruletac, simptac  # noqa: F401  (get_tactic imports them anyway)
    where = os.path.dirname(os.path.abspath(chyp.__file__))
    if os.path.dirname(where) != CHYP_PATH:
        raise ImportError(f'imported chyp from {where}, not from CHYP_PATH={CHYP_PATH}; '
                          'another chyp is installed or was imported first')
    assert_headless()
    return chyp


chyp = _import_core()

from chyp import checker, parser, parts, proofstate, rule, state, term  # noqa: E402
from chyp.graph import Graph  # noqa: E402
from chyp.matcher import find_iso  # noqa: E402
from chyp.parts import (ApplyTacticPart, GenPart, ImportPart, LetPart, Part,  # noqa: E402
                        ProofQedPart, ProofStartPart, ProofStepPart, RewritePart,
                        RulePart, TheoremPart)
from chyp.proofstate import Goal, ProofState  # noqa: E402
from chyp.rule import Rule  # noqa: E402
from chyp.state import State  # noqa: E402
from chyp.tactic import get_tactic  # noqa: E402
from chyp.term import graph_to_term  # noqa: E402


def import_layout() -> Any:
    """Import chyp.layout (and with it cvxpy). Raises ImportError if cvxpy is missing."""
    from chyp import layout
    assert_headless()
    return layout


def chyp_modules() -> list[str]:
    """The chyp.* modules loaded in this process, sorted."""
    return sorted(m for m in sys.modules if m == 'chyp' or m.startswith('chyp.'))


def _read(path: str) -> str | None:
    try:
        with open(path, encoding='utf-8') as f:
            return f.read()
    except OSError:
        return None


def chyp_commit() -> str:
    """The checkout's HEAD commit, read from .git files (no git process, no lock).

    $CHYP_COMMIT overrides it (for a copy without .git, e.g. in Pyodide).
    """
    if os.environ.get('CHYP_COMMIT'):
        return os.environ['CHYP_COMMIT']
    gitdir = os.path.join(CHYP_PATH, '.git')
    if os.path.isfile(gitdir):  # worktree or submodule: "gitdir: <path>"
        txt = _read(gitdir) or ''
        if txt.startswith('gitdir:'):
            gitdir = os.path.normpath(os.path.join(CHYP_PATH, txt[7:].strip()))
    head = (_read(os.path.join(gitdir, 'HEAD')) or '').strip()
    if not head:
        return 'unknown'
    if not head.startswith('ref: '):
        return head
    ref = head[5:]
    sha = _read(os.path.join(gitdir, ref))
    if sha:
        return sha.strip()
    for line in (_read(os.path.join(gitdir, 'packed-refs')) or '').splitlines():
        parts_ = line.split()
        if len(parts_) == 2 and parts_[1] == ref:
            return parts_[0]
    return 'unknown'


def chyp_version() -> str | None:
    """The version in the checkout's setup.py (Chyp 3d28483: 0.5.2)."""
    m = re.search(r'version\s*=\s*["\']([^"\']+)["\']',
                  _read(os.path.join(CHYP_PATH, 'setup.py')) or '')
    return m.group(1) if m else None


def display_path(path: str) -> str:
    """A path for reports: relative to the cwd when under it, else ~-prefixed."""
    path = os.path.abspath(path)
    cwd = os.getcwd()
    if path == cwd or path.startswith(cwd + os.sep):
        return os.path.relpath(path, cwd)
    home = os.path.expanduser('~')
    if path.startswith(home + os.sep):
        return '~' + path[len(home):]
    return path
