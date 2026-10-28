"""chyp_headless: a headless Python API over Chyp, the string-diagram prover.

Chyp (https://github.com/akissinger/chyp, Copyright (C) 2022-2023 Aleks Kissinger,
Apache License 2.0) is imported as an unmodified dependency from a checkout
($CHYP_PATH, default ~/Workspace/chyp) that this package never writes to. No
Qt/GUI module is imported: importing this package raises ImportError if one is
loaded. No Chyp code is copied here (see README.md).

    from chyp_headless import load_theory, check, diagrams, export

    th = load_theory('chyp/orderer-monoid.chyp')    # Chyp's parser
    th.gens, th.rules, th.rewrites, th.errors        # what the file defines
    rep = check(th)                                   # Chyp's checker, per step
    rep.ok, rep.summary(), rep.rewrites[0].steps[0].status
    d = diagrams(th, layout='chyp')                   # Chyp's convex_layout
    doc = export(th)                                  # check + diagrams + provenance

CLI: python -B -m chyp_headless {check,diagrams,export} FILE... (see cli.py).
"""
from __future__ import annotations

import sys

sys.dont_write_bytecode = True  # before anything below imports Chyp

from ._chyp import (CHYP_PATH, assert_headless, chyp_commit, chyp_modules,  # noqa: E402
                    chyp_version, gui_modules)
from .checking import (KNOWN_ISSUES, CheckReport, RewriteResult, StepResult,  # noqa: E402
                       check, suggest)
from .diagrams import (diagrams, graph_dict, layout_available, step_graphs,  # noqa: E402
                       step_match, topology, validate_diagram, validate_diagrams)
from .exporting import dumps, export, index, provenance, write_json  # noqa: E402
from .theory import (By, ChypMessage, Gen, RewriteInfo, RuleInfo, StepInfo,  # noqa: E402
                     Theory, load_theory)

__version__ = '0.1.0'

__all__ = [
    'CHYP_PATH', 'KNOWN_ISSUES', 'By', 'CheckReport', 'ChypMessage', 'Gen', 'RewriteInfo',
    'RewriteResult', 'RuleInfo', 'StepInfo', 'StepResult', 'Theory', '__version__',
    'assert_headless', 'check', 'chyp_commit', 'chyp_modules', 'chyp_version', 'diagrams',
    'dumps', 'export', 'graph_dict', 'gui_modules', 'index', 'layout_available',
    'load_theory', 'provenance', 'step_graphs', 'step_match', 'suggest', 'topology',
    'validate_diagram',
    'validate_diagrams', 'write_json',
]
