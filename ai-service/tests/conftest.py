"""Shared pytest fixtures and path configuration for ai-service tests.

Adds the ``ai-service`` directory to ``sys.path`` regardless of
where pytest is invoked from.
"""
from __future__ import annotations

import sys
from pathlib import Path

_AI_SERVICE_ROOT = Path(__file__).resolve().parent.parent
if str(_AI_SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(_AI_SERVICE_ROOT))
