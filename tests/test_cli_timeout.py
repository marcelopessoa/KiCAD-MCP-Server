"""Tests for the kicad-cli subprocess timeout policy (utils/kicad_cli.cli_timeout)."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "python"))

from utils.kicad_cli import cli_timeout  # noqa: E402

ENV = "KICAD_MCP_CLI_TIMEOUT_SEC"


def test_no_limit_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    # The Node bridge supervises long commands (alerts + interrupt), so a slow
    # kicad-cli run must not be cut off by a fixed limit.
    monkeypatch.delenv(ENV, raising=False)
    assert cli_timeout() is None


@pytest.mark.parametrize("raw, expected", [("900", 900.0), ("2.5", 2.5), (" 60 ", 60.0)])
def test_positive_value_restores_a_hard_limit(
    monkeypatch: pytest.MonkeyPatch, raw: str, expected: float
) -> None:
    monkeypatch.setenv(ENV, raw)
    assert cli_timeout() == expected


@pytest.mark.parametrize("raw", ["", "0", "-5", "abc"])
def test_zero_empty_negative_or_invalid_means_no_limit(
    monkeypatch: pytest.MonkeyPatch, raw: str
) -> None:
    monkeypatch.setenv(ENV, raw)
    assert cli_timeout() is None
