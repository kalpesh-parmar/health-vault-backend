from __future__ import annotations

import io
import logging
import numpy as np
import cv2
from PIL import Image

logger = logging.getLogger(__name__)


def deskew_image(cv_img: np.ndarray, max_angle: float = 45.0) -> np.ndarray:
    """Deskew an image by calculating the dominant text orientation."""
    try:
        gray = cv2.cvtColor(cv_img, cv2.COLOR_BGR2GRAY) if len(cv_img.shape) == 3 else cv_img
        # Invert colors so text is white on black
        thresh = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU)[1]

        # Detect orientation using minAreaRect on non-zero points
        coords = np.column_stack(np.where(thresh > 0))
        if len(coords) < 50:
            return cv_img

        angle = cv2.minAreaRect(coords)[-1]
        if angle < -45.0:
            angle = -(90.0 + angle)
        elif angle > 45.0:
            angle = 90.0 - angle
        else:
            angle = -angle

        # If angle is beyond threshold or negligible, do not rotate
        if abs(angle) > max_angle or abs(angle) < 0.5:
            return cv_img

        (h, w) = cv_img.shape[:2]
        center = (w // 2, h // 2)
        m = cv2.getRotationMatrix2D(center, angle, 1.0)
        rotated = cv2.warpAffine(
            cv_img, m, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE
        )
        return rotated
    except Exception as e:
        logger.warning("Deskew failed, returning original image: %s", e)
        return cv_img


def enhance_contrast_and_remove_shadows(cv_img: np.ndarray) -> np.ndarray:
    """Remove shadows and enhance contrast using morphological background division and CLAHE."""
    try:
        is_color = len(cv_img.shape) == 3
        gray = cv2.cvtColor(cv_img, cv2.COLOR_BGR2GRAY) if is_color else cv_img

        # Estimate background illumination with large morphological closing
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (25, 25))
        bg = cv2.morphologyEx(gray, cv2.MORPH_CLOSE, kernel)

        # Divide gray by background to flatten illumination
        divided = np.float32(gray) / (np.float32(bg) + 1e-5)
        normalized = cv2.normalize(divided, None, 0, 255, cv2.NORM_MINMAX)
        flattened = np.uint8(normalized)

        # Apply CLAHE for local contrast enhancement
        clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
        enhanced = clahe.apply(flattened)

        if is_color:
            return cv2.cvtColor(enhanced, cv2.COLOR_GRAY2BGR)
        return enhanced
    except Exception as e:
        logger.warning("Shadow removal failed: %s", e)
        return cv_img


def adaptive_binarize(cv_img: np.ndarray) -> np.ndarray:
    """Adaptive Gaussian thresholding for binarizing degraded text documents."""
    try:
        gray = cv2.cvtColor(cv_img, cv2.COLOR_BGR2GRAY) if len(cv_img.shape) == 3 else cv_img
        blurred = cv2.GaussianBlur(gray, (3, 3), 0)
        binarized = cv2.adaptiveThreshold(
            blurred, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 21, 10
        )
        return binarized
    except Exception as e:
        logger.warning("Adaptive binarization failed: %s", e)
        return cv_img


def preprocess_document_image(
    image_bytes: bytes,
    deskew: bool = True,
    remove_shadows: bool = True,
    binarize: bool = False,
) -> bytes:
    """Preprocess raw image bytes with deskewing, shadow removal, and contrast enhancement."""
    if not image_bytes:
        return image_bytes

    try:
        nparr = np.frombuffer(image_bytes, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        if img is None:
            return image_bytes

        if deskew:
            img = deskew_image(img)

        if remove_shadows:
            img = enhance_contrast_and_remove_shadows(img)

        if binarize:
            img = adaptive_binarize(img)

        # Encode back to PNG
        ext = ".png" if binarize else ".jpg"
        success, encoded = cv2.imencode(ext, img)
        if success:
            return encoded.tobytes()
        return image_bytes
    except Exception as e:
        logger.warning("Document image preprocessing encountered an error: %s", e)
        return image_bytes
