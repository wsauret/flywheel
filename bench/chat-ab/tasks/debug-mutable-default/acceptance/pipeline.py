"""Tests for the event processing pipeline."""
import pytest
from src.events import Event
from src.processor import process_events
from src.reporter import generate_summary

def make_events():
    return [
        Event(1, "alert", "Server down", priority=10),
        Event(2, "info", "Deployment started", priority=2),
        Event(3, "internal", "Heartbeat", priority=0),
        Event(4, "alert", "High CPU", priority=8),
        Event(5, "info", "Cache cleared", priority=1),
    ]

def test_basic_processing():
    """Process all events — should return all 5 sorted by priority."""
    events = make_events()
    result = process_events(events)
    assert len(result) == 5
    assert result[0].message == "Server down"  # highest priority first

def test_shared_dedup():
    """Shared seen_ids should deduplicate across calls."""
    events = make_events()
    shared = []
    batch1 = process_events(events[:3], seen_ids=shared)
    batch2 = process_events(events, seen_ids=shared)
    # batch2 should only have events 4 and 5 (1-3 already seen)
    assert len(batch2) == 2

def test_process_twice():
    """Two independent calls (no shared seen_ids) should both return all events.

    Each call should process events independently since no seen_ids
    argument is passed — there should be no state leaking between calls.
    """
    events = make_events()

    first = process_events(events)
    assert len(first) == 5, f"First call: expected 5, got {len(first)}"

    second = process_events(events)
    assert len(second) == 5, (
        f"Second call: expected 5, got {len(second)}. "
        f"Events returned: {[e.id for e in second]}"
    )

def test_summary_report():
    events = make_events()
    processed = process_events(events)
    summary = generate_summary(processed)
    assert summary["total"] == 5
    assert summary["highest_priority"] == "Server down"
