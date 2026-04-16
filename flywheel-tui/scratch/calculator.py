"""A simple calculator module with history tracking."""

from typing import List, Optional
from dataclasses import dataclass, field


def add(a: float, b: float) -> float:
    """Add two numbers."""
    return a + b


def subtract(a: float, b: float) -> float:
    """Subtract b from a."""
    return a - b


def multiply(a: float, b: float) -> float:
    """Multiply two numbers."""
    return a * b


def divide(a: float, b: float) -> float:
    """Divide a by b. Raises ZeroDivisionError with a clear message."""
    if b == 0:
        raise ZeroDivisionError("Cannot divide by zero")
    return a / b


def power(a: float, b: float) -> float:
    """Raise a to the power of b."""
    return a ** b


def average(numbers: List[float]) -> Optional[float]:
    """Calculate the average of a list of numbers. Returns None for empty lists."""
    if not numbers:
        return None
    return sum(numbers) / len(numbers)


@dataclass
class Operation:
    name: str
    a: float
    b: float
    result: float


class Calculator:
    OPERATIONS = {
        "add": add,
        "subtract": subtract,
        "multiply": multiply,
        "divide": divide,
        "power": power,
    }

    def __init__(self) -> None:
        self._history: List[Operation] = []

    def calculate(self, operation: str, a: float, b: float) -> float:
        fn = self.OPERATIONS.get(operation)
        if fn is None:
            raise ValueError(f"Unknown operation: {operation}")

        result = fn(a, b)
        self._history.append(Operation(operation, a, b, result))
        return result

    @property
    def history(self) -> List[Operation]:
        return list(self._history)

    def clear_history(self) -> None:
        self._history.clear()

    def last_result(self) -> Optional[float]:
        if not self._history:
            return None
        return self._history[-1].result
