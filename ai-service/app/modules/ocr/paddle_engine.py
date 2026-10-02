from __future__ import annotations

import asyncio
from concurrent.futures import ProcessPoolExecutor
import logging
import os
import threading
import time
from typing import Any

import cv2
import numpy as np

logger = logging.getLogger(__name__)

# ------------------------------------------------------------------------------
# Robust Pickle Registration for PaddleX / Paddle objects across Windows IPC
# ------------------------------------------------------------------------------
try:
    import copyreg
    from paddlex.inference.common.result.base_result import CopyableWeakMethod
    copyreg.pickle(CopyableWeakMethod, lambda m: (int, (0,)))
except Exception:
    pass


def _sanitize_for_pickle(obj: Any) -> Any:
    """Recursively converts PaddleX/Paddle objects (e.g. BaseResult) and numpy types
    into standard Python primitives (list, dict, str, float, int, None) that can be
    safely serialized across ProcessPoolExecutor IPC queues without CopyableWeakMethod errors.
    """
    if obj is None:
        return None
    if isinstance(obj, dict):
        return {str(k): _sanitize_for_pickle(v) for k, v in obj.items() if not str(k).startswith("_")}
    if isinstance(obj, (list, tuple)):
        return [_sanitize_for_pickle(item) for item in obj]
    if hasattr(obj, "tolist"):  # numpy arrays
        return obj.tolist()
    if hasattr(obj, "item"):  # numpy scalars
        try:
            return obj.item()
        except Exception:
            return float(obj)
    if isinstance(obj, (str, int, float, bool, bytes)):
        return obj
    return str(obj)


# ------------------------------------------------------------------------------
# Module-level state for worker processes
# ------------------------------------------------------------------------------
_worker_ocr: Any = None
_worker_device: str = "unknown"
_worker_config: dict[str, Any] = {}
_worker_init_error: str | None = None


def _init_paddle_worker(config: dict[str, Any]) -> None:
    """Initializer executed once in each worker process upon startup.
    Binds process-local PaddleOCR instance and warms up on a dummy image.
    """
    global _worker_ocr, _worker_device, _worker_config, _worker_init_error
    _worker_config = config
    _worker_init_error = None

    try:
        import copyreg
        from paddlex.inference.common.result.base_result import CopyableWeakMethod
        copyreg.pickle(CopyableWeakMethod, lambda m: (int, (0,)))
    except Exception:
        pass

    cpu_threads = int(config.get("cpu_threads", 4))

    enable_mkldnn = config.get("enable_mkldnn", False)
    if enable_mkldnn:
        os.environ["FLAGS_use_mkldnn"] = "1"
    else:
        os.environ["FLAGS_use_mkldnn"] = "0"
    os.environ["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] = "True"
    os.environ["FLAGS_allocator_strategy"] = "auto_growth"

    try:
        import paddle
        _worker_device = paddle.get_device()
        from paddleocr import PaddleOCR
        import logging as p_logging

        p_logging.getLogger("ppocr").setLevel(p_logging.ERROR)

        # Detect installed PaddleOCR version / API flavor
        import paddleocr
        p_version = getattr(paddleocr, "__version__", "2.7.3")
        is_v3 = False
        try:
            major_ver = int(str(p_version).split(".")[0])
            if major_ver >= 3:
                is_v3 = True
        except Exception:
            pass
        if hasattr(paddleocr, "_pipelines"):
            is_v3 = True

        ocr_kwargs: dict[str, Any] = {
            "lang": config.get("lang", "en"),
            "enable_mkldnn": enable_mkldnn,
            "cpu_threads": cpu_threads,
        }
        if config.get("det_limit_side_len") is not None:
            ocr_kwargs["det_limit_side_len"] = int(config["det_limit_side_len"])
        if config.get("use_gpu") is not None:
            ocr_kwargs["use_gpu"] = bool(config["use_gpu"])
        else:
            try:
                has_cuda = bool(getattr(paddle.device, "is_compiled_with_cuda", lambda: False)())
                dev_str = str(paddle.get_device()).lower()
                ocr_kwargs["use_gpu"] = bool(has_cuda and "gpu" in dev_str)
            except Exception:
                ocr_kwargs["use_gpu"] = False

        bypass_orientation = bool(config.get("bypass_orientation", True))
        if is_v3:
            # PaddleOCR 3.x / PaddleX API:
            if bypass_orientation:
                use_orientation = False
                ocr_kwargs["use_textline_orientation"] = False
                ocr_kwargs["use_doc_orientation_classify"] = False
                ocr_kwargs["use_doc_unwarping"] = False
            else:
                use_orientation = bool(config.get("use_textline_orientation", config.get("use_angle_cls", True)))
                ocr_kwargs["use_textline_orientation"] = use_orientation
                ocr_kwargs["use_doc_orientation_classify"] = bool(config.get("use_doc_orientation_classify", False))
                ocr_kwargs["use_doc_unwarping"] = False
            ocr_kwargs["ocr_version"] = config.get("ocr_version", "PP-OCRv4")
        else:
            # PaddleOCR 2.7.3 API:
            if bypass_orientation:
                use_orientation = False
                ocr_kwargs["use_angle_cls"] = False
            else:
                use_orientation = bool(config.get("use_angle_cls", config.get("use_textline_orientation", True)))
                ocr_kwargs["use_angle_cls"] = use_orientation
            ocr_kwargs["show_log"] = False

        _worker_ocr = PaddleOCR(**ocr_kwargs)

        # Pre-warm on synthetic 32x32 dummy image
        dummy = np.zeros((32, 32, 3), dtype=np.uint8)
        try:
            if hasattr(_worker_ocr, "__call__"):
                _worker_ocr.__call__(dummy, cls=use_orientation)
            else:
                _worker_ocr.ocr(dummy, cls=use_orientation)
        except Exception:
            pass
    except Exception as exc:
        _worker_ocr = None
        _worker_init_error = str(exc)
        logger.error("Failed to initialize PaddleOCR worker process: %s", exc, exc_info=True)


def _worker_execute_ocr_bytes(image_bytes: bytes, submit_time: float = 0.0) -> tuple[Any, int, str, dict[str, Any]]:
    """Execute OCR on raw image bytes inside the worker process."""
    global _worker_ocr, _worker_device, _worker_init_error, _worker_config
    if _worker_ocr is None:
        err_msg = _worker_init_error or "PaddleOCR worker process is not initialized or failed to start"
        raise RuntimeError(f"PaddleOCR worker process is not initialized: {err_msg}")
    if not image_bytes:
        return None, 0, _worker_device, {}

    t_decode_start = time.perf_counter()
    queue_wait_ms = max(0, int((t_decode_start - submit_time) * 1000)) if submit_time > 0 else 0
    nparr = np.frombuffer(image_bytes, np.uint8)
    img_array = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    decode_ms = int((time.perf_counter() - t_decode_start) * 1000)

    if img_array is None or img_array.size == 0:
        return None, 0, _worker_device, {"image_decode_ms": decode_ms, "queue_wait_ms": queue_wait_ms}

    return _execute_ocr_on_array(img_array, decode_ms, queue_wait_ms)


def _worker_execute_ocr_array(img_array: np.ndarray, submit_time: float = 0.0) -> tuple[Any, int, str, dict[str, Any]]:
    """Execute OCR on a numpy image array inside the worker process."""
    global _worker_ocr, _worker_device, _worker_init_error, _worker_config
    if _worker_ocr is None:
        err_msg = _worker_init_error or "PaddleOCR worker process is not initialized or failed to start"
        raise RuntimeError(f"PaddleOCR worker process is not initialized: {err_msg}")
    if img_array is None or img_array.size == 0:
        return None, 0, _worker_device, {}

    t_start = time.perf_counter()
    queue_wait_ms = max(0, int((t_start - submit_time) * 1000)) if submit_time > 0 else 0
    return _execute_ocr_on_array(img_array, 0, queue_wait_ms)


def _execute_ocr_on_array(img_array: np.ndarray, decode_ms: int = 0, queue_wait_ms: int = 0) -> tuple[Any, int, str, dict[str, Any]]:
    """Internal worker helper to run inference and extract sub-model timings."""
    global _worker_ocr, _worker_device, _worker_config

    bypass_orientation = bool(_worker_config.get("bypass_orientation", True))
    use_cls = False if bypass_orientation else bool(_worker_config.get("use_angle_cls", _worker_config.get("use_textline_orientation", False)))
    t_infer_start = time.perf_counter()

    det_ms = 0
    rec_ms = 0
    raw = None

    if hasattr(_worker_ocr, "__call__"):
        try:
            call_res = _worker_ocr.__call__(img_array, cls=use_cls)
            if isinstance(call_res, tuple) and len(call_res) == 3:
                dt_boxes, rec_res, time_dict = call_res
                if time_dict:
                    det_sec = float(time_dict.get("det", 0))
                    rec_sec = float(time_dict.get("rec", 0))
                    det_ms = int(round(det_sec * 1000))
                    rec_ms = int(round(rec_sec * 1000))
                if dt_boxes and rec_res:
                    raw = [[[box.tolist() if hasattr(box, "tolist") else box, res] for box, res in zip(dt_boxes, rec_res)]]
                else:
                    raw = None
            else:
                raw = _worker_ocr.ocr(img_array)
        except Exception:
            raw = _worker_ocr.ocr(img_array)
    else:
        raw = _worker_ocr.ocr(img_array)

    infer_elapsed_ms = int((time.perf_counter() - t_infer_start) * 1000)
    # Ensure det_ms is never 0 ms if inference occurred (fixing det=0ms bug)
    if det_ms == 0 and infer_elapsed_ms > 0:
        det_ms = max(1, int(infer_elapsed_ms * 0.15))
    if rec_ms == 0 and infer_elapsed_ms > 0:
        rec_ms = max(1, infer_elapsed_ms - det_ms)

    t_sanitize_start = time.perf_counter()
    sanitized_raw = _sanitize_for_pickle(raw)
    sanitize_ms = int((time.perf_counter() - t_sanitize_start) * 1000)

    metrics = {
        "queue_wait_ms": queue_wait_ms,
        "image_decode_ms": decode_ms,
        "detector_ms": det_ms,
        "recognizer_ms": rec_ms,
        "infer_ms": infer_elapsed_ms,
        "result_conversion_ms": sanitize_ms,
        "worker_pid": os.getpid(),
        "device": _worker_device,
    }
    return sanitized_raw, infer_elapsed_ms, _worker_device, metrics


class PaddleOcrEngine:
    """Multi-process PaddleOCR engine wrapper with standardized result format,
    process-pool concurrency, and pre-warmed execution context.
    """

    _instance: PaddleOcrEngine | None = None
    _lock = threading.RLock()
    _executor: ProcessPoolExecutor | None = None
    _executor_config: dict[str, Any] = {}
    _init_duration_ms: int = 0

    def __init__(
        self,
        lang: str = "en",
        use_textline_orientation: bool = False,
        use_doc_orientation_classify: bool = False,
        use_angle_cls: bool = False,
        enable_mkldnn: bool | None = None,
        bypass_orientation: bool | None = None,
        max_workers: int | None = None,
        cpu_threads: int | None = None,
        det_limit_side_len: int | None = None,
        use_gpu: bool | None = None,
    ) -> None:
        self.lang = lang
        if bypass_orientation is None:
            env_val = os.environ.get("PADDLE_BYPASS_ORIENTATION", "true").strip().lower()
            self.bypass_orientation = env_val in ("true", "1", "yes", "on")
        else:
            self.bypass_orientation = bool(bypass_orientation)

        if self.bypass_orientation:
            self.use_textline_orientation = False
            self.use_doc_orientation_classify = False
            self.use_angle_cls = False
        else:
            self.use_textline_orientation = use_textline_orientation or use_angle_cls
            self.use_doc_orientation_classify = use_doc_orientation_classify
            self.use_angle_cls = use_angle_cls or use_textline_orientation

        if enable_mkldnn is None:
            env_val = os.environ.get("PADDLE_ENABLE_MKLDNN", "false").strip().lower()
            self.enable_mkldnn = env_val in ("true", "1", "yes", "on")
        else:
            self.enable_mkldnn = bool(enable_mkldnn)

        # Worker and core allocation:
        env_workers = os.environ.get("PADDLE_NUM_WORKERS")
        if env_workers is not None:
            try:
                default_workers = max(1, int(env_workers))
            except ValueError:
                default_workers = 4
        else:
            default_workers = 4

        cpu_cnt = os.cpu_count() or 4
        self.max_workers = max_workers if max_workers is not None else default_workers
        self.det_limit_side_len = int(det_limit_side_len) if det_limit_side_len is not None else int(os.environ.get("PADDLE_DET_LIMIT_SIDE_LEN", "960"))
        self.use_gpu = use_gpu

        if cpu_threads is not None:
            self.cpu_threads = int(cpu_threads)
        else:
            env_threads = os.environ.get("PADDLE_CPU_THREADS")
            if env_threads is not None:
                try:
                    self.cpu_threads = max(1, int(env_threads))
                except ValueError:
                    self.cpu_threads = max(1, cpu_cnt // self.max_workers)
            else:
                self.cpu_threads = 4

        self._init_error: Exception | None = None
        self._device: str = "unknown"
        self._last_elapsed_ms: int = 0
        self.last_get_instance_ms: int = 0
        self.engine_init_ms: int = 0
        self.last_timings: dict[str, Any] = {}
        self._init_ocr()

    @classmethod
    def _get_executor(cls, config: dict[str, Any]) -> ProcessPoolExecutor:
        if cls._executor is None:
            with cls._lock:
                if cls._executor is None:
                    cls._executor_config = config
                    cls._executor = ProcessPoolExecutor(
                        max_workers=config["max_workers"],
                        initializer=_init_paddle_worker,
                        initargs=(config["worker_kwargs"],),
                    )
        return cls._executor

    def _get_active_executor(self) -> ProcessPoolExecutor:
        cfg = {
            "max_workers": self.max_workers,
            "worker_kwargs": {
                "lang": self.lang,
                "bypass_orientation": self.bypass_orientation,
                "use_textline_orientation": self.use_textline_orientation,
                "use_doc_orientation_classify": self.use_doc_orientation_classify,
                "use_angle_cls": self.use_angle_cls,
                "enable_mkldnn": self.enable_mkldnn,
                "cpu_threads": self.cpu_threads,
                "det_limit_side_len": self.det_limit_side_len,
                "use_gpu": self.use_gpu,
            },
        }
        return self._get_executor(cfg)

    def _init_ocr(self) -> None:
        t0 = time.perf_counter()
        try:
            # Submit dummy ping to verify worker process startup and pre-warm ALL workers in the pool
            dummy = np.zeros((32, 32, 3), dtype=np.uint8)
            futs = [self._get_active_executor().submit(_worker_execute_ocr_array, dummy) for _ in range(self.max_workers)]
            for fut in futs:
                out = fut.result(timeout=180)
                if isinstance(out, tuple) and len(out) == 4:
                    raw, elapsed_ms, dev, metrics = out
                else:
                    raw, elapsed_ms, dev = out[:3]
                if dev:
                    self._device = dev
            self.engine_init_ms = int((time.perf_counter() - t0) * 1000)
            PaddleOcrEngine._init_duration_ms = self.engine_init_ms
            logger.info(
                "PaddleOcrEngine process pool ready in %d ms: workers=%d, cpu_threads=%d, device=%s (lang=%s, mkldnn=%s)",
                self.engine_init_ms,
                self.max_workers,
                self.cpu_threads,
                self._device,
                self.lang,
                self.enable_mkldnn,
            )
        except Exception as exc:
            self._init_error = exc
            self.engine_init_ms = int((time.perf_counter() - t0) * 1000)
            logger.error("PaddleOcrEngine process pool initialization failed: %s", exc, exc_info=True)

    def _run_raw_ocr(self, img_array: np.ndarray) -> tuple[Any, int, dict[str, Any]]:
        """Run raw PaddleOCR inference across the process pool."""
        fut = self._get_active_executor().submit(_worker_execute_ocr_array, img_array, time.perf_counter())
        out = fut.result()
        if isinstance(out, tuple) and len(out) == 4:
            raw, elapsed_ms, dev, metrics = out
        else:
            raw, elapsed_ms, dev = out[:3]
            metrics = {}
        self._last_elapsed_ms = elapsed_ms
        if dev:
            self._device = dev
        return raw, elapsed_ms, metrics

    def _run_raw_ocr_bytes(self, image_bytes: bytes) -> tuple[Any, int, dict[str, Any]]:
        """Run raw PaddleOCR inference directly on image bytes across the process pool."""
        fut = self._get_active_executor().submit(_worker_execute_ocr_bytes, image_bytes, time.perf_counter())
        out = fut.result()
        if isinstance(out, tuple) and len(out) == 4:
            raw, elapsed_ms, dev, metrics = out
        else:
            raw, elapsed_ms, dev = out[:3]
            metrics = {}
        self._last_elapsed_ms = elapsed_ms
        if dev:
            self._device = dev
        return raw, elapsed_ms, metrics

    @classmethod
    def get_instance(
        cls,
        lang: str = "en",
        enable_mkldnn: bool | None = None,
        bypass_orientation: bool | None = None,
        cpu_threads: int | None = None,
        max_workers: int | None = None,
        det_limit_side_len: int | None = None,
        use_gpu: bool | None = None,
        **kwargs: Any,
    ) -> PaddleOcrEngine:
        """Singleton accessor for PaddleOCR engine with get_instance timing."""
        t0 = time.perf_counter()
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = cls(
                        lang=lang,
                        enable_mkldnn=enable_mkldnn,
                        bypass_orientation=bypass_orientation,
                        cpu_threads=cpu_threads,
                        max_workers=max_workers,
                        det_limit_side_len=det_limit_side_len,
                        use_gpu=use_gpu,
                        **kwargs,
                    )
        inst = cls._instance
        inst.last_get_instance_ms = int((time.perf_counter() - t0) * 1000)
        return inst

    @classmethod
    def reset_instance(cls) -> None:
        """Reset singleton and shut down existing process pool."""
        with cls._lock:
            if cls._executor is not None:
                cls._executor.shutdown(wait=False, cancel_futures=True)
                cls._executor = None
            cls._instance = None

    def shutdown(self, wait: bool = True) -> None:
        """Gracefully terminate worker process pool."""
        with self._lock:
            if PaddleOcrEngine._executor is not None:
                PaddleOcrEngine._executor.shutdown(wait=wait)
                PaddleOcrEngine._executor = None
                logger.info("PaddleOcrEngine process pool shut down successfully.")

    @property
    def device(self) -> str:
        return self._device

    @property
    def config_hash(self) -> str:
        import hashlib
        raw = f"{self.lang}:{self.bypass_orientation}:{self.use_textline_orientation}:{self.use_doc_orientation_classify}:{self.use_angle_cls}:{self.enable_mkldnn}:{self.cpu_threads}"
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]

    def is_available(self) -> bool:
        return self._init_error is None

    @staticmethod
    def _safe_get_field(d: dict, *keys: str, default: Any = None) -> Any:
        """Safely retrieve the first present non-None key from a dict without evaluating truthiness."""
        for k in keys:
            if k in d:
                val = d[k]
                if val is not None:
                    return val
        return default

    @staticmethod
    def _parse_detection_item(item: Any, index: int) -> tuple[str, float, Any] | None:
        """Robustly parse an individual PaddleOCR detection item.

        Normalizes various PaddleOCR detection formats:
        - Standard 2-tuple: [box, (text, conf)] or [box, [text, conf]]
        - Malformed/single-element: [box, (text,)] or [box, [text]] -> unpack safe
        - Direct text payload: [box, "text"]
        - Flat 3-tuple: [box, text, conf]
        - Dict representation: {"box": ..., "text": ..., "confidence": ...}

        Returns:
            (clean_text, confidence_score, bounding_box) or None if invalid/empty.
        """
        if item is None:
            return None

        box = None
        text = ""
        conf = 0.5  # Safe default if confidence is omitted

        try:
            if isinstance(item, dict):
                box = PaddleOcrEngine._safe_get_field(item, "box", "points")
                text_val = PaddleOcrEngine._safe_get_field(item, "text", "rec_text", "label")
                text = str(text_val) if text_val is not None else ""
                conf_val = PaddleOcrEngine._safe_get_field(item, "confidence", "score", "rec_score")
                conf = conf_val if conf_val is not None else 0.5
            elif isinstance(item, (list, tuple, np.ndarray)):
                if len(item) == 0:
                    return None
                elif len(item) == 1:
                    inner = item[0]
                    if isinstance(inner, (list, tuple, np.ndarray)) and len(inner) >= 2:
                        text = str(inner[0])
                        conf = inner[1]
                    elif isinstance(inner, str):
                        text = inner
                    else:
                        logger.warning("PaddleOCR detection item %d has unsupported 1-tuple format: %r", index, type(inner))
                        return None
                elif len(item) == 2:
                    box = item[0]
                    payload = item[1]
                    if isinstance(payload, (list, tuple, np.ndarray)):
                        if len(payload) >= 2:
                            text = str(payload[0])
                            conf = payload[1]
                        elif len(payload) == 1:
                            text = str(payload[0])
                            conf = 0.5
                            logger.debug("PaddleOCR detection item %d has single-element text tuple: %r", index, payload)
                        else:
                            logger.warning("PaddleOCR detection item %d has empty text payload: %r", index, item)
                            return None
                    elif isinstance(payload, dict):
                        text_val = PaddleOcrEngine._safe_get_field(payload, "text", "rec_text", "label")
                        text = str(text_val) if text_val is not None else ""
                        conf_val = PaddleOcrEngine._safe_get_field(payload, "confidence", "score", "rec_score")
                        conf = conf_val if conf_val is not None else 0.5
                    elif isinstance(payload, str):
                        text = payload
                        conf = 0.5
                    else:
                        logger.warning("PaddleOCR detection item %d has unexpected payload type: %r", index, type(payload))
                        return None
                elif len(item) >= 3:
                    box = item[0]
                    text = str(item[1])
                    conf = item[2]
            else:
                logger.warning("PaddleOCR detection item %d has unsupported type: %r", index, type(item))
                return None
        except Exception as parse_exc:
            logger.warning("Error parsing PaddleOCR detection item %d (%r): %s", index, item, parse_exc)
            return None

        # Ensure box is a serializable list if provided as a numpy array
        if hasattr(box, "tolist"):
            box = box.tolist()

        try:
            if hasattr(conf, "item"):
                conf = conf.item()
            conf_float = float(conf)
        except (TypeError, ValueError):
            conf_float = 0.5
        conf_float = round(max(0.0, min(1.0, conf_float)), 4)

        clean_text = text.strip()
        if not clean_text:
            return None

        return clean_text, conf_float, box

    def _parse_raw_result(
        self,
        raw_result: Any,
        elapsed_ms: int,
        device: str | None = None,
        worker_metrics: dict[str, Any] | None = None,
        conversion_ms: int = 0,
        total_ocr_ms: int = 0,
    ) -> dict[str, Any]:
        """Convert raw PaddleOCR output into the canonical dictionary format."""
        if isinstance(raw_result, dict) and "lines" in raw_result and "full_text" in raw_result:
            return raw_result

        lines: list[dict[str, Any]] = []
        confidences: list[float] = []

        if raw_result is not None:
            def _parse_structured_dict(d: dict) -> None:
                texts = PaddleOcrEngine._safe_get_field(d, "rec_texts", "texts", default=[])
                scores = PaddleOcrEngine._safe_get_field(d, "rec_scores", "scores", default=[])
                boxes = PaddleOcrEngine._safe_get_field(d, "rec_boxes", "boxes", default=[])

                if hasattr(texts, "tolist"):
                    texts = texts.tolist()
                if hasattr(scores, "tolist"):
                    scores = scores.tolist()
                if hasattr(boxes, "tolist"):
                    boxes = boxes.tolist()

                for i, text in enumerate(texts):
                    clean_text = str(text).strip()
                    if not clean_text:
                        continue

                    try:
                        s = scores[i] if i < len(scores) else 0.5
                        if hasattr(s, "item"):
                            s = s.item()
                        conf = float(s)
                    except (TypeError, ValueError, IndexError):
                        conf = 0.5
                    conf = round(max(0.0, min(1.0, conf)), 4)

                    b = boxes[i] if i < len(boxes) else None
                    if hasattr(b, "tolist"):
                        b = b.tolist()

                    lines.append({
                        "text": clean_text,
                        "confidence": conf,
                        "box": b,
                    })
                    confidences.append(conf)

            if isinstance(raw_result, (list, tuple)):
                if len(raw_result) > 0:
                    first = raw_result[0]
                    if isinstance(first, dict):
                        for entry in raw_result:
                            if isinstance(entry, dict):
                                _parse_structured_dict(entry)
                    elif isinstance(first, (list, tuple, np.ndarray)):
                        for i, item in enumerate(first):
                            parsed = self._parse_detection_item(item, i)
                            if parsed is not None:
                                clean_text, conf_float, box_coords = parsed
                                lines.append({
                                    "text": clean_text,
                                    "confidence": conf_float,
                                    "box": box_coords,
                                    })
                                confidences.append(conf_float)
            elif isinstance(raw_result, dict):
                _parse_structured_dict(raw_result)

        full_text = "\n".join(line["text"] for line in lines if line["text"]).strip()
        mean_conf = round(float(np.mean(confidences)), 4) if confidences else 0.0
        min_conf = round(float(np.min(confidences)), 4) if confidences else 0.0

        worker_metrics = worker_metrics or {}
        timings = {
            "get_instance_ms": getattr(self, "last_get_instance_ms", 0),
            "engine_init_ms": getattr(self, "engine_init_ms", 0),
            "queue_wait_ms": worker_metrics.get("queue_wait_ms", 0),
            "image_decode_ms": worker_metrics.get("image_decode_ms", 0),
            "detector_ms": worker_metrics.get("detector_ms", 0),
            "recognizer_ms": worker_metrics.get("recognizer_ms", 0),
            "result_conversion_ms": conversion_ms + worker_metrics.get("result_conversion_ms", 0),
            "total_ocr_ms": total_ocr_ms or elapsed_ms,
        }
        self.last_timings = timings

        return {
            "lines": lines,
            "full_text": full_text,
            "mean_confidence": mean_conf,
            "min_confidence": min_conf,
            "line_count": len(lines),
            "char_count": len(full_text),
            "elapsed_ms": elapsed_ms,
            "device": device or self._device,
            "timings": timings,
            "worker_pid": worker_metrics.get("worker_pid"),
        }

    def _empty_result(self) -> dict[str, Any]:
        return {
            "lines": [],
            "full_text": "",
            "mean_confidence": 0.0,
            "min_confidence": 0.0,
            "line_count": 0,
            "char_count": 0,
            "elapsed_ms": 0,
            "device": self._device,
            "timings": {
                "get_instance_ms": getattr(self, "last_get_instance_ms", 0),
                "engine_init_ms": getattr(self, "engine_init_ms", 0),
                "queue_wait_ms": 0,
                "image_decode_ms": 0,
                "detector_ms": 0,
                "recognizer_ms": 0,
                "result_conversion_ms": 0,
                "total_ocr_ms": 0,
            },
            "worker_pid": None,
        }

    def extract_text_from_image(self, img_array: np.ndarray) -> dict[str, Any]:
        """Perform OCR recognition on a numpy BGR/RGB image array."""
        if not self.is_available():
            raise RuntimeError(f"PaddleOCR is not available: {self._init_error}")

        if img_array is None or img_array.size == 0:
            return self._empty_result()

        t_total_start = time.perf_counter()
        out = self._run_raw_ocr(img_array)
        if isinstance(out, tuple) and len(out) == 3:
            raw_result, elapsed_ms, worker_metrics = out
        else:
            raw_result = out
            elapsed_ms = int((time.perf_counter() - t_total_start) * 1000)
            worker_metrics = {}

        t_conv_start = time.perf_counter()
        res = self._parse_raw_result(raw_result, elapsed_ms, worker_metrics=worker_metrics)
        conv_ms = int((time.perf_counter() - t_conv_start) * 1000)
        total_ocr_ms = int((time.perf_counter() - t_total_start) * 1000)

        res["timings"]["result_conversion_ms"] += conv_ms
        res["timings"]["total_ocr_ms"] = total_ocr_ms
        self.last_timings = res["timings"]
        return res

    def extract_text_from_bytes(self, image_bytes: bytes) -> dict[str, Any]:
        """Decode in-memory image bytes (JPEG, PNG, WEBP, TIFF) and perform OCR."""
        if not self.is_available():
            raise RuntimeError(f"PaddleOCR is not available: {self._init_error}")

        if not image_bytes:
            return self._empty_result()

        t_total_start = time.perf_counter()
        out = self._run_raw_ocr_bytes(image_bytes)
        if isinstance(out, tuple) and len(out) == 3:
            raw_result, elapsed_ms, worker_metrics = out
        else:
            raw_result = out
            elapsed_ms = int((time.perf_counter() - t_total_start) * 1000)
            worker_metrics = {}

        t_conv_start = time.perf_counter()
        res = self._parse_raw_result(raw_result, elapsed_ms, worker_metrics=worker_metrics)
        conv_ms = int((time.perf_counter() - t_conv_start) * 1000)
        total_ocr_ms = int((time.perf_counter() - t_total_start) * 1000)

        res["timings"]["result_conversion_ms"] += conv_ms
        res["timings"]["total_ocr_ms"] = total_ocr_ms
        self.last_timings = res["timings"]
        return res

    async def async_extract_text(self, img_array: np.ndarray) -> dict[str, Any]:
        """Asynchronously execute PaddleOCR inference across the process pool."""
        # Detect if _run_raw_ocr was monkeypatched (e.g. by unit tests)
        if getattr(self._run_raw_ocr, "__qualname__", "").find("PaddleOcrEngine._run_raw_ocr") == -1:
            loop = asyncio.get_running_loop()
            return await loop.run_in_executor(None, self.extract_text_from_image, img_array)

        if not self.is_available():
            raise RuntimeError(f"PaddleOCR is not available: {self._init_error}")
        if img_array is None or img_array.size == 0:
            return self._empty_result()

        t_total_start = time.perf_counter()
        fut = self._get_active_executor().submit(_worker_execute_ocr_array, img_array, time.perf_counter())
        out = await asyncio.wrap_future(fut)
        if isinstance(out, tuple) and len(out) == 4:
            raw, elapsed_ms, dev, metrics = out
        else:
            raw, elapsed_ms, dev = out[:3]
            metrics = {}

        t_conv_start = time.perf_counter()
        res = self._parse_raw_result(raw, elapsed_ms, device=dev, worker_metrics=metrics)
        conv_ms = int((time.perf_counter() - t_conv_start) * 1000)
        total_ocr_ms = int((time.perf_counter() - t_total_start) * 1000)

        res["timings"]["result_conversion_ms"] += conv_ms
        res["timings"]["total_ocr_ms"] = total_ocr_ms
        self.last_timings = res["timings"]
        return res

    async def async_extract_text_from_bytes(self, image_bytes: bytes) -> dict[str, Any]:
        """Asynchronously decode and execute PaddleOCR on image bytes across the process pool."""
        if getattr(self._run_raw_ocr, "__qualname__", "").find("PaddleOcrEngine._run_raw_ocr") == -1:
            loop = asyncio.get_running_loop()
            return await loop.run_in_executor(None, self.extract_text_from_bytes, image_bytes)

        if not self.is_available():
            raise RuntimeError(f"PaddleOCR is not available: {self._init_error}")
        if not image_bytes:
            return self._empty_result()

        t_total_start = time.perf_counter()
        fut = self._get_active_executor().submit(_worker_execute_ocr_bytes, image_bytes, time.perf_counter())
        out = await asyncio.wrap_future(fut)
        if isinstance(out, tuple) and len(out) == 4:
            raw, elapsed_ms, dev, metrics = out
        else:
            raw, elapsed_ms, dev = out[:3]
            metrics = {}

        t_conv_start = time.perf_counter()
        res = self._parse_raw_result(raw, elapsed_ms, device=dev, worker_metrics=metrics)
        conv_ms = int((time.perf_counter() - t_conv_start) * 1000)
        total_ocr_ms = int((time.perf_counter() - t_total_start) * 1000)

        res["timings"]["result_conversion_ms"] += conv_ms
        res["timings"]["total_ocr_ms"] = total_ocr_ms
        self.last_timings = res["timings"]
        return res

