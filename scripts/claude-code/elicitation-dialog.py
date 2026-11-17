#!/usr/bin/env python3
"""Claude Code `Elicitation` hook: show MCP single-choice questions as a Windows dialog.

Why: the Claude Code VS Code extension runs the CLI in print mode, where an MCP
elicitation that no hook answers is declined automatically -- the user never
sees it. That silently disables the KiCad server's "interrupt this long
command?" question. This hook answers single-choice questions (one property
with an `enum`, e.g. the watchdog's "continuar" / "interromper") with a
top-most Windows dialog driven through powershell.exe, so it works from WSL.

Anything it cannot render (several fields, free text, URL mode, no
powershell.exe) gets no output, so Claude Code falls back to its normal
handling. Closing the dialog or letting it time out also produces no output.
When Claude Code aborts the hook (the server withdrew the question because the
command finished), the dialog is closed too.

Register it in ~/.claude/settings.json, matching only the KiCad server:

    "hooks": {
      "Elicitation": [{
        "matcher": "kicad",
        "hooks": [{
          "type": "command",
          "command": "/usr/bin/python3 -I /path/to/scripts/claude-code/elicitation-dialog.py",
          "timeout": 600
        }]
      }]
    }

Environment: KICAD_MCP_DIALOG_TIMEOUT_SEC (default 290) closes an unanswered
dialog, a little before the server's next question.
"""

from __future__ import annotations

import base64
import json
import os
import shutil
import signal
import subprocess
import sys
from typing import Any, Dict, List, Optional

POWERSHELL_DIALOG = r"""
$ErrorActionPreference = 'Stop'
$data = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__DATA__')) | ConvertFrom-Json
[Console]::Out.WriteLine("PID:$PID"); [Console]::Out.Flush()

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$form = New-Object System.Windows.Forms.Form
$form.Text = $data.title
$form.TopMost = $true
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.AutoSize = $true
$form.AutoSizeMode = 'GrowAndShrink'
$form.Padding = New-Object System.Windows.Forms.Padding(14)
$form.Font = New-Object System.Drawing.Font('Segoe UI', 10)

$layout = New-Object System.Windows.Forms.FlowLayoutPanel
$layout.FlowDirection = 'TopDown'
$layout.AutoSize = $true
$layout.WrapContents = $false

$label = New-Object System.Windows.Forms.Label
$label.Text = $data.message
$label.AutoSize = $true
$label.MaximumSize = New-Object System.Drawing.Size(520, 0)
$label.Margin = New-Object System.Windows.Forms.Padding(0, 0, 0, 14)
$layout.Controls.Add($label)

$buttons = New-Object System.Windows.Forms.FlowLayoutPanel
$buttons.FlowDirection = 'LeftToRight'
$buttons.AutoSize = $true
$global:choice = $null
for ($i = 0; $i -lt $data.labels.Count; $i++) {
    $button = New-Object System.Windows.Forms.Button
    $button.Text = $data.labels[$i]
    $button.Tag = $i
    $button.AutoSize = $true
    $button.Padding = New-Object System.Windows.Forms.Padding(8, 4, 8, 4)
    $button.Add_Click({ $global:choice = $this.Tag; $form.Close() })
    $buttons.Controls.Add($button)
}
$layout.Controls.Add($buttons)
$form.Controls.Add($layout)

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = [int]$data.timeoutMs
$timer.Add_Tick({ $form.Close() })
$timer.Start()

$form.Add_Shown({ $form.Activate(); [System.Media.SystemSounds]::Exclamation.Play() })
[void]$form.ShowDialog()
if ($null -ne $global:choice) { [Console]::Out.WriteLine("CHOICE:$($global:choice)"); [Console]::Out.Flush() }
"""


def single_choice(request: Dict[str, Any]) -> Optional[tuple]:
    """(field, values, labels) for a one-property enum form, else None."""
    if request.get("mode", "form") != "form":
        return None
    properties = (request.get("requested_schema") or {}).get("properties") or {}
    if len(properties) != 1:
        return None
    ((field, spec),) = properties.items()
    values = spec.get("enum") if isinstance(spec, dict) else None
    if not values or not all(isinstance(v, str) for v in values):
        return None
    labels = spec.get("enumNames")
    if not isinstance(labels, list) or len(labels) != len(values):
        labels = values
    return field, values, [str(label) for label in labels]


def ask(title: str, message: str, labels: List[str], timeout_sec: float) -> Optional[int]:
    """Show the dialog; index of the clicked button, or None if closed/timed out."""
    powershell = shutil.which("powershell.exe")
    if not powershell:
        return None
    payload = json.dumps(
        {"title": title, "message": message, "labels": labels, "timeoutMs": int(timeout_sec * 1000)}
    )
    script = POWERSHELL_DIALOG.replace(
        "__DATA__", base64.b64encode(payload.encode("utf-8")).decode("ascii")
    )
    encoded = base64.b64encode(script.encode("utf-16-le")).decode("ascii")
    proc = subprocess.Popen(
        [powershell, "-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
    )
    windows_pid: Optional[int] = None

    def close_dialog(*_: Any) -> None:
        # Killing the WSL-side proxy alone may leave the Windows window open.
        if windows_pid is not None and shutil.which("taskkill.exe"):
            subprocess.run(
                ["taskkill.exe", "/PID", str(windows_pid), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        proc.kill()
        sys.exit(0)  # no output: Claude Code handles the question as usual

    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, close_dialog)

    choice: Optional[int] = None
    assert proc.stdout is not None
    for line in proc.stdout:
        line = line.strip()
        if line.startswith("PID:"):
            windows_pid = int(line[4:])
        elif line.startswith("CHOICE:"):
            choice = int(line[7:])
    proc.wait()
    return choice


def main() -> int:
    try:
        request = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        return 0
    form = single_choice(request)
    if form is None:
        return 0
    field, values, labels = form
    try:
        timeout_sec = float(os.environ.get("KICAD_MCP_DIALOG_TIMEOUT_SEC", "290"))
    except ValueError:
        timeout_sec = 290.0
    title = f"Claude Code — {request.get('mcp_server_name', 'MCP')}"
    choice = ask(title, str(request.get("message", "")), labels, max(5.0, timeout_sec))
    if choice is None or not 0 <= choice < len(values):
        return 0
    print(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": "Elicitation",
                    "action": "accept",
                    "content": {field: values[choice]},
                }
            }
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
