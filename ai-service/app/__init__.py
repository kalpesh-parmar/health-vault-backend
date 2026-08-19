"""Unified Health Vault AI service."""

# Safely pre-load PyTorch native DLLs before any other module (e.g. Paddle/PaddleOCR) loads OpenMP on Windows
try:
    import torch  # noqa: F401
except Exception:
    pass
