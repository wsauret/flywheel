# Python Language Standards

## Type Hints (Required)

- ALWAYS use type hints for function parameters and return values
- Use modern Python 3.10+ syntax: `list[str]` not `List[str]`, `str | None` not `Optional[str]`
- Use `TypeAlias` or `type` statements for complex types
- Prefer `typing.Protocol` over abstract base classes for structural typing
- Use `@overload` for functions with different return types based on input

## Pythonic Patterns

- Use context managers (`with` statements) for resource management
- Prefer list/dict comprehensions over explicit loops (when readable)
- Use dataclasses or Pydantic models for structured data
- Use properties with `@property` decorator, not getter/setter methods
- Prefer `pathlib` over `os.path`, f-strings over `.format()`
- Use `enum.Enum` for fixed sets of values, not magic strings
- Use `functools.cache`/`lru_cache` for expensive pure functions
- Prefer `collections.defaultdict` and `Counter` over manual dict accumulation

## Error Handling

- Catch specific exceptions, never bare `except:`
- Use custom exception classes for domain errors
- Prefer EAFP (Easier to Ask Forgiveness) over LBYL (Look Before You Leap) when appropriate
- Always include meaningful error messages
- Use `raise ... from e` to preserve exception chains

## Imports

- Follow PEP 8 ordering: stdlib, third-party, local
- Use absolute imports
- Avoid wildcard imports (`from module import *`)
- Group imports with blank lines between sections

## Testing

- Use `pytest` conventions: `test_` prefix, fixtures over setup/teardown
- Use `pytest.raises` for exception testing
- Prefer `pytest.mark.parametrize` for testing multiple inputs
- Mock at the boundary, not deep internals
- Use `conftest.py` for shared fixtures, scoped appropriately

## Performance

- Profile before optimizing -- use `cProfile` or `py-spy`
- Use generators and `itertools` for large data processing
- Prefer `str.join()` over string concatenation in loops
- Use `__slots__` on high-volume dataclasses/classes
- Be aware of GIL implications for CPU-bound concurrency
- Use `asyncio` for I/O-bound concurrency, `multiprocessing` for CPU-bound
- Avoid repeated attribute lookups in tight loops

## Anti-Patterns to Flag

- Mutable default arguments (`def f(items=[])`)
- Using `type()` instead of `isinstance()` for type checks
- String concatenation in loops (use `str.join`)
- Nested functions deeper than 2 levels
- Functions longer than ~50 lines without extraction
- `# type: ignore` without explanation
- Bare `except:` or `except Exception:` that swallows errors silently
- Using `global` or `nonlocal` without strong justification
- Re-raising without `from` (loses traceback context)

## Debugging Checklist

When investigating Python issues, check:
- Mutable default arguments causing shared state across calls
- Late binding in closures (loop variable capture)
- Import-time side effects causing test flakiness
- `__eq__` without `__hash__` breaking set/dict behavior
- Floating point comparison without tolerance
- Silent `None` returns from missing explicit return statements
