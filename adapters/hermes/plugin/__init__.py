"""Mnemos plugin for Hermes Agent.

Registers lifecycle hooks for vault health at session start and capture at session end.
Requires the `mnemos` CLI to be installed and available on PATH.
"""

from .hooks import on_session_start, on_session_end


def register(ctx):
    ctx.register_hook("on_session_start", on_session_start)
    ctx.register_hook("on_session_end", on_session_end)
