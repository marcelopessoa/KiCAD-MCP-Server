"""Tests for the Claude Code Elicitation hook (scripts/claude-code/elicitation-dialog.py).

The dialog itself needs Windows (powershell.exe); these tests cover what the hook
decides to show and what it prints, which is what Claude Code acts on.
"""

from __future__ import annotations

import importlib.util
import io
import json
from pathlib import Path

import pytest

HOOK = Path(__file__).parent.parent / "scripts" / "claude-code" / "elicitation-dialog.py"
spec = importlib.util.spec_from_file_location("elicitation_dialog", HOOK)
hook = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(hook)

WATCHDOG_QUESTION = {
    "hook_event_name": "Elicitation",
    "mcp_server_name": "kicad",
    "mode": "form",
    "message": 'O comando KiCad "run_erc" está rodando há 5min. Interromper?',
    "requested_schema": {
        "type": "object",
        "properties": {
            "acao": {
                "type": "string",
                "enum": ["continuar", "interromper"],
                "enumNames": ["Continuar aguardando", "Interromper o comando"],
            }
        },
        "required": ["acao"],
    },
}


def run_hook(monkeypatch: pytest.MonkeyPatch, request: dict, capsys) -> str:
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(request)))
    assert hook.main() == 0
    return capsys.readouterr().out


def test_single_choice_reads_the_watchdog_question() -> None:
    assert hook.single_choice(WATCHDOG_QUESTION) == (
        "acao",
        ["continuar", "interromper"],
        ["Continuar aguardando", "Interromper o comando"],
    )


def test_single_choice_falls_back_to_values_without_matching_labels() -> None:
    request = json.loads(json.dumps(WATCHDOG_QUESTION))
    request["requested_schema"]["properties"]["acao"]["enumNames"] = ["só um"]
    assert hook.single_choice(request)[2] == ["continuar", "interromper"]


@pytest.mark.parametrize(
    "schema",
    [
        {"properties": {"a": {"type": "string"}}},  # free text
        {"properties": {"a": {"enum": ["x"]}, "b": {"enum": ["y"]}}},  # two fields
        {"properties": {"a": {"enum": [1, 2]}}},  # non-string choices
        {},
    ],
)
def test_other_forms_are_left_to_claude_code(schema: dict) -> None:
    assert hook.single_choice({"mode": "form", "requested_schema": schema}) is None


def test_url_mode_is_left_to_claude_code() -> None:
    assert hook.single_choice({**WATCHDOG_QUESTION, "mode": "url"}) is None


def test_clicked_choice_is_returned_as_accept(monkeypatch: pytest.MonkeyPatch, capsys) -> None:
    monkeypatch.setattr(hook, "ask", lambda title, message, labels, timeout: 1)
    out = json.loads(run_hook(monkeypatch, WATCHDOG_QUESTION, capsys))
    assert out == {
        "hookSpecificOutput": {
            "hookEventName": "Elicitation",
            "action": "accept",
            "content": {"acao": "interromper"},
        }
    }


def test_closed_or_timed_out_dialog_prints_nothing(
    monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    monkeypatch.setattr(hook, "ask", lambda title, message, labels, timeout: None)
    assert run_hook(monkeypatch, WATCHDOG_QUESTION, capsys) == ""


def test_no_powershell_prints_nothing(monkeypatch: pytest.MonkeyPatch, capsys) -> None:
    monkeypatch.setattr(hook.shutil, "which", lambda name: None)
    assert run_hook(monkeypatch, WATCHDOG_QUESTION, capsys) == ""


def test_invalid_input_prints_nothing(monkeypatch: pytest.MonkeyPatch, capsys) -> None:
    monkeypatch.setattr("sys.stdin", io.StringIO("not json"))
    assert hook.main() == 0
    assert capsys.readouterr().out == ""
