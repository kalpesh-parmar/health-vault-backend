from __future__ import annotations

from collections import OrderedDict
import copy
from dataclasses import dataclass
import hashlib
import logging
import threading
import time
from typing import Any

logger = logging.getLogger(__name__)


def compute_ocr_cache_key(
    image_bytes: bytes,
    pipeline_version: str = "v1.0",
    engine_config_hash: str = "",
) -> str:
    """Computes a deterministic SHA-256 digest over image payload, pipeline version,
    and engine configuration signature.
    """
    hasher = hashlib.sha256()
    hasher.update(image_bytes)
    hasher.update(pipeline_version.encode("utf-8"))
    hasher.update(engine_config_hash.encode("utf-8"))
    return hasher.hexdigest()


@dataclass
class OcrCacheEntry:
    cached_data: dict[str, Any]
    created_at: float
    hits: int = 0


class OcrResultCache:
    """Thread-safe LRU in-memory cache for page OCR extractions keyed by SHA-256.
    Ensures zero cache poisoning: only extractions with status == 'SUCCESS' are retained.
    """

    _default_instance: OcrResultCache | None = None
    _singleton_lock: threading.Lock = threading.Lock()

    def __init__(
        self,
        max_entries: int = 500,
        ttl_seconds: float = 86400.0,
        pipeline_version: str = "v1.0",
    ) -> None:
        self.max_entries = max(1, max_entries)
        self.ttl_seconds = ttl_seconds
        self.pipeline_version = pipeline_version
        self._cache: OrderedDict[str, OcrCacheEntry] = OrderedDict()
        self._lock = threading.RLock()
        self._hits = 0
        self._misses = 0

    @classmethod
    def get_default(cls) -> OcrResultCache:
        """Access singleton default cache instance."""
        if cls._default_instance is None:
            with cls._singleton_lock:
                if cls._default_instance is None:
                    cls._default_instance = cls()
        return cls._default_instance

    def compute_key(
        self,
        image_bytes: bytes,
        engine_config_hash: str = "",
        pipeline_version: str | None = None,
    ) -> str:
        version = pipeline_version or self.pipeline_version
        return compute_ocr_cache_key(image_bytes, version, engine_config_hash)

    def get(
        self,
        image_bytes: bytes,
        engine_config_hash: str = "",
        pipeline_version: str | None = None,
    ) -> dict[str, Any] | None:
        """Retrieve a cached result if present and within TTL.
        Returns a deepcopy with 'cached': True and elapsed_ms = 0.
        """
        if not image_bytes:
            return None

        key = self.compute_key(image_bytes, engine_config_hash, pipeline_version)
        t0 = time.monotonic()

        with self._lock:
            entry = self._cache.get(key)
            if entry is None:
                self._misses += 1
                return None

            now = time.time()
            if (now - entry.created_at) > self.ttl_seconds:
                del self._cache[key]
                self._misses += 1
                return None

            self._cache.move_to_end(key)
            entry.hits += 1
            self._hits += 1

            ret = copy.deepcopy(entry.cached_data)
            ret["cached"] = True
            ret["elapsed_ms"] = int((time.monotonic() - t0) * 1000)
            return ret

    def set(
        self,
        image_bytes: bytes,
        result: dict[str, Any],
        engine_config_hash: str = "",
        pipeline_version: str | None = None,
    ) -> None:
        """Store extraction result in LRU cache.
        Strict invariant: Only results with status == 'SUCCESS' are cached to prevent cache poisoning.
        """
        if not image_bytes or not isinstance(result, dict):
            return

        if result.get("status") != "SUCCESS":
            logger.debug("Skipping caching for non-successful OCR result (status=%s)", result.get("status"))
            return

        key = self.compute_key(image_bytes, engine_config_hash, pipeline_version)

        with self._lock:
            if key in self._cache:
                self._cache.move_to_end(key)
                self._cache[key].cached_data = copy.deepcopy(result)
                self._cache[key].created_at = time.time()
            else:
                if len(self._cache) >= self.max_entries:
                    self._cache.popitem(last=False)

                self._cache[key] = OcrCacheEntry(
                    cached_data=copy.deepcopy(result),
                    created_at=time.time(),
                    hits=0,
                )

    def clear(self) -> None:
        """Clear all cached entries and reset metrics."""
        with self._lock:
            self._cache.clear()
            self._hits = 0
            self._misses = 0

    def stats(self) -> dict[str, Any]:
        """Return cache health metrics."""
        with self._lock:
            total = self._hits + self._misses
            ratio = round(self._hits / total, 4) if total > 0 else 0.0
            return {
                "hits": self._hits,
                "misses": self._misses,
                "entries": len(self._cache),
                "max_entries": self.max_entries,
                "hit_ratio": ratio,
            }
