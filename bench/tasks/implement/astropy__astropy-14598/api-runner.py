import pytest
import runpy
import sys

sys.argv = sys.argv[1:]
runpy.run_path(sys.argv[0], run_name="__main__")
