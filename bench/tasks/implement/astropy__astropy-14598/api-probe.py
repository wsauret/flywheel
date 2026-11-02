import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import sys

cwd = Path.cwd().resolve()
sys.path.insert(0, str(cwd))
import astropy
from astropy.io import fits
import astropy.io.fits.card as card_module
import astropy.io.fits._utils as native_utils
import astropy.io.fits._tiled_compression._compression as native_compression
import numpy
import pytest

assert Path(card_module.__file__).resolve() == cwd / 'astropy/io/fits/card.py'
assert Path(native_utils.__file__).resolve().parent == cwd / 'astropy/io/fits'
assert Path(native_compression.__file__).resolve().parent == cwd / 'astropy/io/fits/_tiled_compression'
examples = []
for label, ns, suffix in [('original_terminal_quotes', range(60,70), "''"), ('original_embedded_quotes', range(50,70), "''"+'x'*10)]:
    for n in ns:
        value = 'x' * n + suffix
        original = fits.Card('CONFIG', value)
        serialized = str(original)
        actual = fits.Card.fromstring(serialized).value
        examples.append({'domain':label,'n':n,'expected':value,'actual':actual,'equal':actual == value,'serialization':serialized})
for value in ['x'*100+"''", 'x'*100+"''xxx", 'x'*100+"'' xxx"]:
    original = fits.Card('TEST',value)
    actual = fits.Card.fromstring(original.image).value
    examples.append({'domain':'canonical_added_test_values','expected':value,'actual':actual,'equal':actual == value,'serialization':original.image})
result = {
 'platform':platform.platform(), 'machine':platform.machine(), 'python':sys.version,
 'astropy':astropy.__version__, 'numpy':numpy.__version__, 'pytest':pytest.__version__,
 'cwd':str(cwd), 'cardModule':str(card_module.__file__),
 'nativeModules':[{ 'path':mod.__file__, 'sha256':hashlib.sha256(Path(mod.__file__).read_bytes()).hexdigest(), 'bytes':Path(mod.__file__).stat().st_size} for mod in (native_utils,native_compression)],
 'packages':{dist.metadata['Name']:dist.version for dist in importlib.metadata.distributions()},
 'examples':examples,
 'summary':{label:{'total':sum(x['domain']==label for x in examples), 'passing':sum(x['domain']==label and x['equal'] for x in examples), 'mismatching_n':[x.get('n') for x in examples if x['domain']==label and not x['equal']]} for label in sorted({x['domain'] for x in examples})}
}
Path(sys.argv[1]).write_text(json.dumps(result,indent=2))
print(json.dumps(result,indent=2))
