import logging
import asyncio
from typing import Optional

logger = logging.getLogger(__name__)

class LanguageDetectionService:
    def __init__(self) -> None:
        self.model = None
        self.is_warm = False
        self._lock = asyncio.Lock()
        
        self.language_codes = {
            "eng_Latn": "english",
            "guj_Latn": "gujarati",
            "guj_Gujr": "gujarati",
            "hin_Latn": "hindi",
            "hin_Deva": "hindi",
            "mar_Latn": "marathi",
            "mar_Deva": "marathi",
            "tam_Latn": "tamil",
            "tam_Taml": "tamil",
        }

    async def warm_up(self) -> None:
        """Download and load the glotlid model during startup."""
        logger.info("[LanguageDetectionService] Starting model warmup...")
        try:
            from huggingface_hub import hf_hub_download
            import fasttext

            def _load():
                model_path = hf_hub_download(
                    repo_id="cis-lmu/glotlid",
                    filename="model.bin"
                )
                return fasttext.load_model(model_path)
            
            loop = asyncio.get_running_loop()
            self.model = await loop.run_in_executor(None, _load)
            self.is_warm = True
            logger.info("[LanguageDetectionService] Model loaded successfully.")
        except Exception as e:
            logger.error(f"[LanguageDetectionService] Failed to load model: {e}", exc_info=True)
            self.model = None
            self.is_warm = False

    async def detect_language(self, text: str) -> Optional[str]:
        """Detect the language of the provided text."""
        if not text or not text.strip():
            return "english"

        if not self.is_warm or not self.model:
            logger.warning("[LanguageDetectionService] Model not warm, defaulting to english.")
            return "english"
            
        try:
            # fasttext needs single line input, no newlines
            clean_text = text.replace("\n", " ").replace("\r", " ").strip()
            
            async with self._lock:
                labels, probabilities = self.model.predict(clean_text, k=1)
                
            if labels and len(labels) > 0:
                label = labels[0].replace("__label__", "")
                language_name = self.language_codes.get(label, label)
                confidence = float(probabilities[0])
                
                logger.info(f"[LanguageDetectionService] Detected {language_name} (label: {label}, confidence: {confidence:.2f})")
                
                # If confidence is extremely low, we might still fallback to english
                # but glotlid is generally quite good even for short texts
                return language_name
            return "english"
        except Exception as e:
            logger.error(f"[LanguageDetectionService] Error during language detection: {e}")
            return "english"
