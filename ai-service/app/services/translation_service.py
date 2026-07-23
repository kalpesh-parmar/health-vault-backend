from __future__ import annotations

import asyncio
import logging
import os
import re
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from app.settings import Settings

logger = logging.getLogger(__name__)


def mask_text(text: str) -> tuple[str, list[str]]:
    masks = []
    
    # Entity patterns to protect
    patterns = [
        ("email", r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}'),
        ("phone", r'\+?\d{1,4}[-.\s]?\d{3,5}[-.\s]?\d{3,5}(?:[-.\s]?\d{1,4})?'),
        ("date", r'\b\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}\b'),
        ("blood", r'(?<![A-Za-z])(?:AB|A|B|O)[+-]'),
    ]
    
    masked_text = text
    matches = []
    for name, pat in patterns:
        for match in re.finditer(pat, masked_text):
            matches.append((match.start(), match.end(), match.group(0)))
    
    # Sort matches by start index descending to prevent indexing shifts
    matches.sort(key=lambda x: x[0], reverse=True)
    
    # Deduplicate overlapping matches
    clean_matches = []
    last_start = len(text) + 1
    for start, end, val in matches:
        if end <= last_start:
            clean_matches.append((start, end, val))
            last_start = start
            
    clean_matches.reverse()  # forward order
    
    final_text = ""
    curr_idx = 0
    for start, end, val in clean_matches:
        final_text += text[curr_idx:start]
        mask_str = f"__MASK_{len(masks)}__"
        final_text += mask_str
        masks.append(val)
        curr_idx = end
    final_text += text[curr_idx:]
    
    return final_text, masks


def unmask_text(masked_text: str, masks: list[str]) -> str:
    def replace_match(match):
        try:
            idx = int(match.group(1))
            if 0 <= idx < len(masks):
                return masks[idx]
        except Exception:
            pass
        return match.group(0)
    
    pattern = r'__\s*MASK_(\d+)\s*__'
    unmasked = re.sub(pattern, replace_match, masked_text, flags=re.IGNORECASE)
    return unmasked


class TranslationService:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.tokenizer = None
        self.model = None
        self.ip = None
        self.device = "cpu"
        self.is_warm = False
        self._lock = asyncio.Lock()

    async def warm_up(self) -> None:
        logger.info("[TranslationService] Starting translation model warmup...")
        try:
            import torch
            from transformers import AutoModelForSeq2SeqLM, AutoTokenizer, __version__ as tf_version
            from IndicTransToolkit.processor import IndicProcessor
            from packaging.version import Version

            resolved_token = self.settings.hf_token or os.environ.get("HF_TOKEN")
            if resolved_token:
                model_name = self.settings.translation_model_name
                self.device = "cuda" if torch.cuda.is_available() else "cpu"
                logger.info(f"[TranslationService] Device selected: {self.device}")

                kwargs = {}
                if Version(tf_version) >= Version("4.32"):
                    kwargs["token"] = resolved_token
                else:
                    kwargs["use_auth_token"] = resolved_token

                self.tokenizer = AutoTokenizer.from_pretrained(model_name, trust_remote_code=True, **kwargs)
                self.model = AutoModelForSeq2SeqLM.from_pretrained(
                    model_name,
                    trust_remote_code=True,
                    **kwargs
                ).to(self.device)
                self.is_warm = True
                logger.info("[TranslationService] Translation model loaded successfully.")
            else:
                logger.warning("[TranslationService] Translation is disabled because HF_TOKEN is not configured.")
                self.is_warm = False

            self.ip = IndicProcessor(inference=True)
        except Exception as e:
            logger.error(f"[TranslationService] Failed to warm up translation model: {e}", exc_info=True)
            self.tokenizer = None
            self.model = None
            self.ip = None
            self.is_warm = False

    def map_lang_code(self, lang: str) -> str:
        # Standardize source and target language parameters to AI4Bharat codes
        l_clean = lang.strip().lower()
        mapping = {
            "english": "eng_Latn",
            "en": "eng_Latn",
            "gujarati": "guj_Gujr",
            "gu": "guj_Gujr",
            "hindi": "hin_Deva",
            "hi": "hin_Deva",
            "marathi": "mar_Deva",
            "mr": "mar_Deva",
            "tamil": "tam_Taml",
            "ta": "tam_Taml",
        }
        return mapping.get(l_clean, "eng_Latn")

    def split_sentences(self, text: str) -> list[str]:
        sentences = re.split(r'(?<=[.!?])\s+', text)
        return [s.strip() for s in sentences if s.strip()]

    async def translate(self, text: str, src_lang: str, tgt_lang: str) -> str:
        if not text:
            return text
            
        if not self.is_warm:
            logger.warning("[TranslationService] Model not warm, returning original text")
            return text

        src_code = self.map_lang_code(src_lang)
        tgt_code = self.map_lang_code(tgt_lang)

        if src_code == tgt_code:
            return text

        masked_text, masks = mask_text(text)
        sentences = self.split_sentences(masked_text)
        if not sentences:
            return text

        try:
            import torch
            translated_sentences = []
            
            for sentence in sentences:
                batch = self.ip.preprocess_batch([sentence], src_lang=src_code, tgt_lang=tgt_code)
                
                inputs = self.tokenizer(
                    batch,
                    truncation=True,
                    padding="longest",
                    return_tensors="pt"
                ).to(self.device)

                loop = asyncio.get_running_loop()
                async with self._lock:
                    def _generate():
                        with torch.no_grad():
                            return self.model.generate(
                                **inputs,
                                use_cache=True,
                                min_length=0,
                                max_length=256,
                                num_beams=self.settings.translation_num_beams,
                                num_return_sequences=1
                            )
                    generated_tokens = await loop.run_in_executor(None, _generate)

                decoded = self.tokenizer.batch_decode(generated_tokens, skip_special_tokens=True)
                translated_sentences.append(decoded[0] if decoded else sentence)

            translated_text = " ".join(translated_sentences)
            unmasked_text = unmask_text(translated_text, masks)
            return unmasked_text
        except Exception as e:
            logger.error(f"[TranslationService] Error during translation: {e}", exc_info=True)
            return text
