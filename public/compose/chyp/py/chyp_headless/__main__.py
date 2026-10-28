"""python -B -m chyp_headless {check,diagrams,export} FILE... (see chyp_headless/cli.py)."""
import sys

sys.dont_write_bytecode = True

from .cli import main  # noqa: E402

sys.exit(main())
