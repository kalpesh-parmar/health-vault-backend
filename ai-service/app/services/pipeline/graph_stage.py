from __future__ import annotations

import asyncio
import io
import logging
from pathlib import Path
from typing import Any

import fitz  # PyMuPDF
from PIL import Image

from app.infrastructure.storage.s3 import S3StorageClient
from app.modules.vision.visual_asset_filter import VisualAssetFilter

logger = logging.getLogger(__name__)


class GraphStageHandler:
    """Extracts genuine clinical visual assets (ECG waveforms, radiological scans, clinical trend charts)
    from document pages using a 5-stage filter to eliminate whole-page scans, letterheads, and logos.
    Generates crops, uploads to S3, and stores metadata pointers.
    """

    def __init__(
        self,
        s3_client: S3StorageClient,
        visual_filter: VisualAssetFilter | None = None,
    ) -> None:
        self.s3_client = s3_client
        self.visual_filter = visual_filter or VisualAssetFilter()

    async def extract_graphs(
        self,
        file_path: Path,
        file_key: str,
        bucket: str,
        raw_ocr_data: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        logger.info("Extracting visual graph and clinical image assets from %s", file_path)
        extracted_graphs: list[dict[str, Any]] = []

        is_pdf = file_path.suffix.lower() == ".pdf"
        if not file_path.exists():
            return extracted_graphs

        try:
            if is_pdf:
                extracted_graphs = await asyncio.to_thread(
                    self._extract_pdf_visual_assets, file_path, file_key, bucket
                )
            else:
                extracted_graphs = await asyncio.to_thread(
                    self._extract_raster_visual_assets, file_path, file_key, bucket
                )
        except Exception as e:
            logger.warning("Visual asset extraction encountered an error: %s", e)

        # Upload extracted crops to S3 concurrently
        upload_semaphore = asyncio.Semaphore(4)

        async def upload_crop(idx: int, g: dict[str, Any]) -> dict[str, Any]:
            crop_bytes = g.pop("cropBytes", None)
            if crop_bytes:
                crop_key = f"{file_key}.graph_{idx}.png"
                try:
                    async with upload_semaphore:
                        await self.s3_client.upload_bytes(
                            bucket=bucket,
                            key=crop_key,
                            data=crop_bytes,
                            content_type="image/png",
                        )
                    g["s3Key"] = crop_key
                    g["s3Bucket"] = bucket
                except Exception as upload_err:
                    logger.warning("Failed to upload graph crop %s to S3: %s", crop_key, upload_err)
            return g

        uploaded_graphs = await asyncio.gather(
            *(upload_crop(idx, g) for idx, g in enumerate(extracted_graphs))
        )

        logger.info("Visual asset extraction completed: %d assets saved", len(uploaded_graphs))
        return list(uploaded_graphs)

    def _extract_pdf_visual_assets(
        self, file_path: Path, file_key: str, bucket: str
    ) -> list[dict[str, Any]]:
        raw_candidates: list[dict[str, Any]] = []
        with fitz.open(str(file_path)) as doc:
            total_pages = doc.page_count
            for page_idx in range(total_pages):
                page = doc.load_page(page_idx)
                page_rect = page.rect
                page_w = int(page_rect.width)
                page_h = int(page_rect.height)
                image_list = page.get_images(full=True)

                for img_idx, img_info in enumerate(image_list):
                    xref = img_info[0]
                    base_image = doc.extract_image(xref)
                    image_bytes = base_image.get("image")
                    image_ext = base_image.get("ext", "png")
                    width = base_image.get("width", 0)
                    height = base_image.get("height", 0)

                    if not image_bytes or width < 20 or height < 20:
                        continue

                    try:
                        pil_img = Image.open(io.BytesIO(image_bytes))
                    except Exception:
                        continue

                    # Determine placement coordinates on page
                    image_rects = page.get_image_rects(xref)
                    if image_rects:
                        r = image_rects[0]
                        bbox = [int(r.y0), int(r.x0), int(r.y1), int(r.x1)]
                        crop_w = int(r.width)
                        crop_h = int(r.height)
                    else:
                        bbox = [0, 0, height, width]
                        crop_w = width
                        crop_h = height

                    verdict = self.visual_filter.evaluate_candidate_crop(
                        image=pil_img,
                        bbox=bbox,
                        page_w=page_w or crop_w,
                        page_h=page_h or crop_h,
                    )

                    if not verdict.passed:
                        logger.debug(
                            "Page %d image %d rejected by %s: %s",
                            page_idx + 1,
                            img_idx,
                            verdict.stage_rejected,
                            verdict.reason,
                        )
                        continue

                    aspect_ratio = crop_w / max(crop_h, 1)
                    graph_type = verdict.asset_type or "clinical_image"
                    if graph_type == "ecg_waveform_strip":
                        title = f"ECG Rhythm Strip (Page {page_idx + 1})"
                    elif graph_type == "radiology_scan":
                        title = f"Radiological Scan (Page {page_idx + 1})"
                    elif graph_type == "clinical_chart":
                        title = f"Clinical Trend Chart (Page {page_idx + 1})"
                    else:
                        title = f"Clinical Diagram (Page {page_idx + 1})"

                    raw_candidates.append(
                        {
                            "graphType": graph_type,
                            "title": title,
                            "page": page_idx + 1,
                            "bbox": bbox,
                            "metadata": {
                                "width": crop_w,
                                "height": crop_h,
                                "aspectRatio": round(aspect_ratio, 2),
                                "originalExt": image_ext,
                                "confidence": verdict.confidence,
                            },
                            "cropBytes": image_bytes,
                            "image_bytes": image_bytes,
                        }
                    )

        # Stage 4: Cross-page perceptual hash repetition filtering
        filtered_graphs = self.visual_filter.filter_repetitive_crops(raw_candidates, total_pages)
        for g in filtered_graphs:
            g.pop("image_bytes", None)
            g.pop("dhash", None)

        return filtered_graphs

    def _extract_raster_visual_assets(
        self, file_path: Path, file_key: str, bucket: str
    ) -> list[dict[str, Any]]:
        graphs: list[dict[str, Any]] = []
        with Image.open(file_path) as img:
            w, h = img.size
            # Evaluate whether the whole raster image is a standalone clinical asset
            # (e.g. standalone ECG strip or X-ray photograph vs a whole-page prescription/document scan)
            verdict = self.visual_filter.evaluate_candidate_crop(
                image=img,
                bbox=[0, 0, w, h],
                page_w=w,
                page_h=h,
            )

            if not verdict.passed:
                logger.info(
                    "Raster image %s rejected as visual asset by %s: %s",
                    file_path.name,
                    verdict.stage_rejected,
                    verdict.reason,
                )
                return graphs

            aspect = w / max(h, 1)
            graph_type = verdict.asset_type or ("ecg_waveform_strip" if aspect >= 3.0 else "clinical_image")
            title = "ECG Rhythm Strip" if graph_type == "ecg_waveform_strip" else "Diagnostic Clinical Image"

            buf = io.BytesIO()
            img.save(buf, format="PNG")
            graphs.append(
                {
                    "graphType": graph_type,
                    "title": title,
                    "page": 1,
                    "bbox": [0, 0, w, h],
                    "metadata": {
                        "width": w,
                        "height": h,
                        "aspectRatio": round(aspect, 2),
                        "confidence": verdict.confidence,
                        "filterReason": verdict.reason,
                    },
                    "cropBytes": buf.getvalue(),
                }
            )
        return graphs
