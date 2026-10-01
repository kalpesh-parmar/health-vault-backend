from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any


@dataclass
class StageTiming:
    stage: str
    duration_ms: int
    started_at: float
    completed_at: float
    metadata: dict[str, Any] = field(default_factory=dict)


class TimingTracker:
    """Tracks structured granular latencies across all 9 canonical pipeline stages
    and detailed sub-operations/LLM telemetry.
    
    Persisted into checkpoint_data.timings for benchmark analysis and telemetry.
    """

    def __init__(self) -> None:
        self.pipeline_start = time.monotonic()
        self.stage_starts: dict[str, float] = {}
        self.stage_timings: dict[str, StageTiming] = {}
        self.sub_operations: dict[str, int] = {}
        self.llm_metrics: list[dict[str, Any]] = []
        self.per_page_timings: list[dict[str, Any]] = []
        self.pure_ocr_ms: int = 0
        self.vlm_inference_ms: int = 0
        self.storage_read_ms: int = 0
        self.pdf_inspection_ms: int = 0

    def start_stage(self, stage: str) -> None:
        self.stage_starts[stage] = time.monotonic()

    def end_stage(self, stage: str, **metadata: Any) -> int:
        started = self.stage_starts.pop(stage, None)
        if started is None:
            return 0
        now = time.monotonic()
        duration_ms = int((now - started) * 1000)
        self.stage_timings[stage] = StageTiming(
            stage=stage,
            duration_ms=duration_ms,
            started_at=started,
            completed_at=now,
            metadata=metadata,
        )
        return duration_ms

    def record_sub_operation(self, name: str, duration_ms: int) -> None:
        self.sub_operations[name] = self.sub_operations.get(name, 0) + duration_ms

    def record_llm_metric(
        self,
        *,
        model: str,
        duration_ms: int,
        prompt_tokens: int = 0,
        completion_tokens: int = 0,
        total_tokens: int = 0,
    ) -> None:
        self.llm_metrics.append(
            {
                "callIndex": len(self.llm_metrics) + 1,
                "model": model,
                "durationMs": duration_ms,
                "promptTokens": prompt_tokens,
                "completionTokens": completion_tokens,
                "totalTokens": total_tokens or (prompt_tokens + completion_tokens),
            }
        )

    def record_ocr_metric(self, *, pure_ocr_ms: int = 0, vlm_ms: int = 0, per_page: list[dict[str, Any]] | None = None) -> None:
        self.pure_ocr_ms += pure_ocr_ms
        self.vlm_inference_ms += vlm_ms
        if per_page:
            self.per_page_timings.extend(per_page)

    def record_storage_read(self, duration_ms: int) -> None:
        self.storage_read_ms += duration_ms

    def record_pdf_inspection(self, duration_ms: int) -> None:
        self.pdf_inspection_ms += duration_ms

    def to_dict(self) -> dict[str, Any]:
        total_elapsed_ms = int((time.monotonic() - self.pipeline_start) * 1000)
        stages_breakdown = {
            s: t.duration_ms for s, t in self.stage_timings.items()
        }
        total_llm_ms = sum(m.get("durationMs", 0) for m in self.llm_metrics)
        total_prompt_tokens = sum(m.get("promptTokens", 0) for m in self.llm_metrics)
        total_completion_tokens = sum(m.get("completionTokens", 0) for m in self.llm_metrics)

        return {
            "totalElapsedMs": total_elapsed_ms,
            "storageReadMs": self.storage_read_ms,
            "pdfInspectionMs": self.pdf_inspection_ms,
            "pureOcrMs": self.pure_ocr_ms,
            "vlmInferenceMs": self.vlm_inference_ms,
            "stages": stages_breakdown,
            "subOperations": self.sub_operations,
            "llmTelemetry": {
                "totalCalls": len(self.llm_metrics),
                "totalDurationMs": total_llm_ms,
                "totalPromptTokens": total_prompt_tokens,
                "totalCompletionTokens": total_completion_tokens,
                "calls": self.llm_metrics,
            },
            "perPage": self.per_page_timings,
        }
