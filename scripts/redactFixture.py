#!/usr/bin/env python3
"""Wrapper invoking ai-service/scripts/redactFixture.py."""
import sys
from pathlib import Path

ai_service_script = Path(__file__).resolve().parent.parent / "ai-service" / "scripts" / "redactFixture.py"
if not ai_service_script.exists():
    print(f"Cannot find {ai_service_script}", file=sys.stderr)
    sys.exit(1)

# Execute the ai-service script with the same python interpreter and arguments
import runpy
sys.path.insert(0, str(ai_service_script.parent.parent))
runpy.run_path(str(ai_service_script), run_name="__main__")
