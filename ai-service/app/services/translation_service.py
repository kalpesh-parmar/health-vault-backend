from __future__ import annotations

import asyncio
import logging
import os
import re
import uuid
from typing import TYPE_CHECKING, Any

from app.core.errors import TranslationError

if TYPE_CHECKING:
    from app.services.language_detection_service import LanguageDetectionService
    from app.services.llm import LLMService
    from app.settings import Settings

logger = logging.getLogger(__name__)

MARATHI_MARKERS = {
    "आहे", "आहेत", "नाही", "नाहीत", "आणि", "च्या", "मध्ये", "वर", "केले", "केली", "करावे",
    "घ्यावे", "द्यावे", "रुग्ण", "रुग्णाला", "तपासणी", "औषध", "औषधे", "दिवसातून", "वेळा",
    "दोनदा", "एकदा", "रक्तदाब", "वाढले", "कमी", "होते", "असावे", "पाहिजे", "येथे", "तसेच",
    "घ्या", "द्या", "केलेले", "असल्यास"
}

HINDI_MARKERS = {
    "है", "हैं", "नहीं", "और", "के", "की", "का", "में", "पर", "किया", "किए", "करें",
    "लें", "दें", "मरीज", "रोगी", "जांच", "दवा", "दवाएं", "दिन", "बार", "दो बार",
    "एक बार", "रक्तचाप", "बढ़", "घट", "था", "थी", "होना", "चाहिए", "तथा", "गया", "गई"
}


def mask_text(text: str, placeholder_style: str = "white_square") -> tuple[str, list[str]]:
    masks = []
    
    # Entity patterns to protect
    patterns = [
        ("email", r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}'),
        ("phone", r'\+?\d{1,4}[-.\s]?\d{3,5}[-.\s]?\d{3,5}(?:[-.\s]?\d{1,4})?'),
        ("date_named", r'(?i)\b\d{1,2}-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*-\d{2,4}\b'),
        ("date_slash", r'\b\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}\b'),
        ("dosage_frequency", r'\b[012]-[012]-[012]\b'),
        ("clinical_frequency", r'(?i)\b(?:OD|BD|TID|QID|QDS|TDS|HS|PRN|SOS|STAT)\b'),
        ("range", r'(?i)\b\d+(?:\.\d+)?\s*(?:-|to)\s*\d+(?:\.\d+)?(?:\s*(?:%|(?:mg\/dL|g\/dL|µg\/dL|ug\/dL|mcg\/dL|mg\/L|mmol\/L|µmol\/L|umol\/L|uIU\/mL|mU\/L|IU\/mL|pg\/mL|ng\/mL|fL|pg|mg|ml|gm|mcg|iu|mEq\/L|cells\/mcL|ng\/dL|mIU\/mL)\b))?'),
        ("number_unit", r'(?i)\b\d+(?:\.\d+)?\s*(?:%|(?:mg\/dL|g\/dL|µg\/dL|ug\/dL|mcg\/dL|mg\/L|mmol\/L|µmol\/L|umol\/L|uIU\/mL|mU\/L|IU\/mL|pg\/mL|ng\/mL|fL|pg|mg|ml|gm|mcg|iu|mm\/hr|sec|seconds|min|minutes|hrs|hours|days|tablets|capsules|pills|mEq\/L|cells\/mcL|ng\/dL|mIU\/mL)\b)'),
        ("bp", r'(?i)\b\d{2,3}\/\d{2,3}(?:\s*mmHg)?\b'),
        ("blood", r'(?<![A-Za-z])(?:AB|A|B|O)[+-]'),
        ("medical_terms", r'(?i)\b(?:HbA1c|TSH|PT\/INR|INR|Hb|Hemoglobin|WBC|RBC|Platelet\s+Count|Platelets|Creatinine|LDL|HDL|VLDL|Cholesterol|Triglycerides|Bilirubin|Urea|BUN|Glucose|FBS|PPBS|RBS|SGOT|AST|SGPT|ALT|Alkaline\s+Phosphatase|ALP|Total\s+Protein|Albumin|Globulin|Calcium|Sodium|Potassium|Chloride|Uric\s+Acid|ESR|CRP|Vitamin\s+D|Vitamin\s+B12|Ferritin|Iron|TIBC|PSA|FT3|FT4|Troponin|D-Dimer|Metformin|Atorvastatin|Telmisartan|Amlodipine|Paracetamol|Azithromycin|Amoxicillin|Pantoprazole|Omeprazole|Ciprofloxacin|Losartan|Levothyroxine)\b'),
        ("number_standalone", r'\b\d+(?:\.\d+)?\b'),
    ]
    
    matches = []
    for name, pat in patterns:
        for match in re.finditer(pat, text):
            matches.append((match.start(), match.end(), match.group(0)))
    
    # Sort matches by start index ascending, length descending
    matches.sort(key=lambda x: (x[0], -(x[1] - x[0])))
    
    # Deduplicate overlapping matches
    clean_matches = []
    last_end = -1
    for start, end, val in matches:
        if start >= last_end:
            clean_matches.append((start, end, val))
            last_end = end
            
    final_text = ""
    curr_idx = 0
    for i, (start, end, val) in enumerate(clean_matches):
        final_text += text[curr_idx:start]
        placeholder = f"{{{i + 1}}}" if placeholder_style == "curly" else f"⟦{i + 1}⟧"
        final_text += placeholder
        masks.append(val)
        curr_idx = end
    final_text += text[curr_idx:]
    
    return final_text, masks


def unmask_text(masked_text: str, masks: list[str]) -> str:
    def replace_match(match: re.Match) -> str:
        for group in match.groups():
            if group is not None:
                try:
                    idx = int(group) - 1
                    if 0 <= idx < len(masks):
                        return masks[idx]
                except Exception:
                    pass
        return ""
    
    pattern = r'⟦\s*(\d+)\s*⟧|\{\s*(\d+)\s*\}|\[\s*(\d+)\s*\]'
    unmasked = re.sub(pattern, replace_match, masked_text)
    return unmasked


def validate_placeholder_integrity(translated_text: str, expected_count: int) -> bool:
    if not translated_text:
        return expected_count == 0
    pattern = r'⟦\s*(\d+)\s*⟧|\{\s*(\d+)\s*\}|\[\s*(\d+)\s*\]'
    found = [g for match in re.finditer(pattern, translated_text) for g in match.groups() if g is not None]
    if len(found) != expected_count:
        return False
    found_set = set(found)
    expected_set = {str(i) for i in range(1, expected_count + 1)}
    return found_set == expected_set


def strip_think_tokens(text: str) -> str:
    if not text:
        return ""
    cleaned = re.sub(r"<(?:think|thinking|reasoning)\b[^>]*>[\s\S]*?</(?:think|thinking|reasoning)>", "", text, flags=re.IGNORECASE)
    cleaned = re.sub(r"<(?:think|thinking|reasoning)\b[^>]*>[\s\S]*$", "", cleaned, flags=re.IGNORECASE)
    # Strip any trailing 'Note:' or commentary often generated by LLMs
    cleaned = re.sub(r"(?i)\n*(?:Note|Explanation|Translation Note):\s*[\s\S]*$", "", cleaned)
    return cleaned.strip()


def split_sentences_clean(text: str) -> list[str]:
    if not text:
        return []
    protected = re.sub(r'\b(Dr|Mr|Mrs|Ms|Prof|Sr|Jr|Tab|Cap|Inj|vs|e\.g|i\.e)\.', r'\1⟦DOT⟧', text, flags=re.IGNORECASE)
    parts = re.split(r'(?<=[.!?;\n])\s+', protected)
    return [p.replace("⟦DOT⟧", ".").strip() for p in parts if p.strip()]


def _patch_decoder_for_transformers_cache(model: Any) -> None:
    """Patches the IndicTrans2 decoder forward pass for transformers >= 4.36 compatibility.
    
    Recent transformers versions initialize decoder past_key_values as an
    EncoderDecoderCache containing (None, None, None, None) on step 0, which triggers
    an AttributeError when past_key_values[0][0].shape is queried.
    """
    if hasattr(model, "model") and hasattr(model.model, "decoder"):
        decoder = model.model.decoder
        orig_forward = decoder.forward

        def patched_forward(*args: Any, **kwargs: Any) -> Any:
            pkv = kwargs.get("past_key_values")
            if pkv is not None and len(pkv) > 0 and (pkv[0] is None or pkv[0][0] is None):
                kwargs["past_key_values"] = None
            return orig_forward(*args, **kwargs)

        decoder.forward = patched_forward


class TranslationService:
    def __init__(
        self,
        settings: Settings,
        llm_service: LLMService | None = None,
        language_detection: LanguageDetectionService | None = None,
    ) -> None:
        self.settings = settings
        self.llm = llm_service
        self.language_detection = language_detection
        self.en_indic_tokenizer = None
        self.en_indic_model = None
        self.indic_en_tokenizer = None
        self.indic_en_model = None
        self.ip = None
        self.device = "cpu"
        self.is_en_indic_warm = False
        self.is_indic_en_warm = False
        self.is_warm = False
        self.last_metadata: dict[str, Any] = {}
        self._lock = asyncio.Lock()

    async def warm_up(self) -> None:
        logger.info("[TranslationService] Starting translation engine warmup...")
        try:
            import torch
            from transformers import AutoModelForSeq2SeqLM, AutoTokenizer, __version__ as tf_version
            from IndicTransToolkit.processor import IndicProcessor
            from packaging.version import Version

            self.device = "cuda" if torch.cuda.is_available() else "cpu"
            logger.info(f"[TranslationService] PyTorch device selected: {self.device}")

            resolved_token = getattr(self.settings, "hf_token", None) or os.environ.get("HF_TOKEN")
            if hasattr(self.settings, "hf_token") and self.settings.hf_token is None and not os.environ.get("HF_TOKEN"):
                logger.warning("[TranslationService] Translation is disabled because HF_TOKEN is explicitly configured as None.")
                self.is_warm = False
                try:
                    self.ip = IndicProcessor(inference=True)
                except Exception:
                    self.ip = None
                return

            kwargs: dict[str, Any] = {}
            if resolved_token:
                if Version(tf_version) >= Version("4.32"):
                    kwargs["token"] = resolved_token
                else:
                    kwargs["use_auth_token"] = resolved_token

            # 1. Warm up English -> Indic model (primary requirement for medical summarization)
            en_indic_name = "ai4bharat/indictrans2-en-indic-dist-200M"
            try:
                logger.info(f"[TranslationService] Loading {en_indic_name}...")
                self.en_indic_tokenizer = AutoTokenizer.from_pretrained(en_indic_name, trust_remote_code=True, **kwargs)
                loaded_en_indic = AutoModelForSeq2SeqLM.from_pretrained(
                    en_indic_name,
                    trust_remote_code=True,
                    **kwargs
                ).to(self.device)
                _patch_decoder_for_transformers_cache(loaded_en_indic)
                self.en_indic_model = loaded_en_indic
                self.is_en_indic_warm = True
                logger.info(f"[TranslationService] {en_indic_name} loaded and patched successfully.")
            except Exception as e:
                logger.warning(f"[TranslationService] Failed to load en-indic model: {e}")
                self.en_indic_tokenizer = None
                self.en_indic_model = None
                self.is_en_indic_warm = False

            # 2. Warm up Indic -> English model (isolated to avoid blocking en_indic)
            indic_en_name = "ai4bharat/indictrans2-indic-en-dist-200M"
            try:
                logger.info(f"[TranslationService] Checking local availability of {indic_en_name}...")
                self.indic_en_tokenizer = AutoTokenizer.from_pretrained(
                    indic_en_name,
                    trust_remote_code=True,
                    local_files_only=True,
                    **kwargs,
                )
                loaded_indic_en = AutoModelForSeq2SeqLM.from_pretrained(
                    indic_en_name,
                    trust_remote_code=True,
                    local_files_only=True,
                    **kwargs,
                ).to(self.device)
                _patch_decoder_for_transformers_cache(loaded_indic_en)
                self.indic_en_model = loaded_indic_en
                self.is_indic_en_warm = True
                logger.info(f"[TranslationService] {indic_en_name} loaded and patched successfully.")
            except Exception as e:
                logger.warning(f"[TranslationService] Indic-en model unavailable or gated (optional): {e}")
                self.indic_en_tokenizer = None
                self.indic_en_model = None
                self.is_indic_en_warm = False

            try:
                self.ip = IndicProcessor(inference=True)
            except Exception as e:
                logger.warning(f"[TranslationService] IndicProcessor initialization failed: {e}")
                self.ip = None

            self.is_warm = (self.is_en_indic_warm and self.ip is not None) or (self.llm is not None)
            logger.info(f"[TranslationService] Engine warmup complete | IndicTrans2 en->indic: {self.is_en_indic_warm}, LLM fallback available: {self.llm is not None}")

        except Exception as e:
            logger.error(f"[TranslationService] Unexpected failure during translation warmup: {e}", exc_info=True)
            self.is_warm = (self.llm is not None)

    def canonical_language_name(self, lang: str) -> str:
        clean = (lang or "").strip().lower()
        mapping = {
            "english": "english",
            "en": "english",
            "gujarati": "gujarati",
            "gu": "gujarati",
            "hindi": "hindi",
            "hi": "hindi",
            "marathi": "marathi",
            "mr": "marathi",
            "tamil": "tamil",
            "ta": "tamil",
            "tn": "tamil",
        }
        return mapping.get(clean, clean)

    def map_lang_code(self, lang: str) -> str:
        # Standardize source and target language parameters to AI4Bharat codes
        l_clean = (lang or "").strip().lower()
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
            "tn": "tam_Taml",
        }
        return mapping.get(l_clean, "eng_Latn")

    def split_sentences(self, text: str) -> list[str]:
        return split_sentences_clean(text)

    async def _translate_with_indictrans2(self, text: str, src_lang: str, tgt_lang: str, request_id: str) -> str:
        if not self.is_en_indic_warm or self.ip is None:
            raise TranslationError("IndicTrans2 en->indic model is not initialized or warm.")

        src_code = self.map_lang_code(src_lang)
        tgt_code = self.map_lang_code(tgt_lang)

        current_tokenizer = self.en_indic_tokenizer if tgt_code != "eng_Latn" else self.indic_en_tokenizer
        current_model = self.en_indic_model if tgt_code != "eng_Latn" else self.indic_en_model

        if current_model is None or current_tokenizer is None:
            raise TranslationError(f"IndicTrans2 model not available for route {src_code} -> {tgt_code}")

        paragraphs = text.split('\n')
        all_sentences: list[str] = []
        sentence_to_para_map: list[int] = []

        for i, para in enumerate(paragraphs):
            if not para.strip():
                continue
            sentences = self.split_sentences(para)
            for s in sentences:
                all_sentences.append(s)
                sentence_to_para_map.append(i)

        if not all_sentences:
            return text

        total_sentences = len(all_sentences)
        batch_size = 4
        translated_sentences = []

        import time
        start_time = time.time()
        import torch

        async with self._lock:
            for i in range(0, total_sentences, batch_size):
                sentence_batch = all_sentences[i:i + batch_size]
                batch = self.ip.preprocess_batch(sentence_batch, src_lang=src_code, tgt_lang=tgt_code)
                inputs = current_tokenizer(
                    batch,
                    truncation=True,
                    padding="longest",
                    return_tensors="pt"
                ).to(self.device)

                loop = asyncio.get_running_loop()

                def _generate(inputs_arg=inputs, model_arg=current_model):
                    with torch.no_grad():
                        return model_arg.generate(
                            **inputs_arg,
                            use_cache=True,
                            min_length=0,
                            max_length=256,
                            num_beams=self.settings.translation_num_beams,
                            num_return_sequences=1
                        )

                generated_tokens = await loop.run_in_executor(None, _generate)
                decoded = current_tokenizer.batch_decode(generated_tokens, skip_special_tokens=True)
                postprocessed = self.ip.postprocess_batch(decoded, lang=tgt_code)
                translated_sentences.extend(postprocessed)

        translated_paragraphs = [""] * len(paragraphs)
        for i, translated_sent in zip(sentence_to_para_map, translated_sentences):
            if translated_paragraphs[i]:
                translated_paragraphs[i] += " " + translated_sent
            else:
                translated_paragraphs[i] = translated_sent

        translated_text = "\n".join(translated_paragraphs)

        logger.info(f"[TranslationService][{request_id}] IndicTrans2 translated {len(text)} chars to {tgt_lang} in {time.time() - start_time:.2f}s")
        return translated_text

    async def _translate_with_ollama(self, text: str, src_lang: str, tgt_lang: str, request_id: str) -> str:
        if self.llm is None:
            raise TranslationError("LLMService is not injected; Ollama translation fallback unavailable.")

        target_canonical = self.canonical_language_name(tgt_lang).capitalize()
        masked_text, masks = mask_text(text)

        system_instruction = (
            f"You are a professional medical translator. Translate the following clinical summary into {target_canonical}.\n"
            "MANDATORY RULES:\n"
            "1. Preserve all placeholders like ⟦1⟧, ⟦2⟧ EXACTLY as they appear without any translation, spacing change, or alteration.\n"
            "2. Translate all surrounding clinical text accurately, naturally, and grammatically.\n"
            "3. Preserve all medicine names, dosages, frequencies, and lab parameters exactly.\n"
            "4. NEVER invent or hallucinate clinical details, treatments, or medication schedules.\n"
            "5. Output ONLY the translated text. Do not provide commentary, notes, or explanations."
        )

        model_name = getattr(self.settings, "translation_model", "qwen2.5:14b") or "qwen2.5:14b"
        logger.info(f"[TranslationService][{request_id}] Calling Ollama fallback using model {model_name} for {target_canonical}")

        response = await self.llm.chat(
            messages=[
                {"role": "system", "content": system_instruction},
                {"role": "user", "content": masked_text},
            ],
            model=model_name,
            temperature=0.0,
            num_predict=1024,
        )

        cleaned_raw = strip_think_tokens(response)
        if not validate_placeholder_integrity(cleaned_raw, len(masks)):
            logger.warning(f"[TranslationService][{request_id}] Ollama output failed placeholder integrity check. Expected {len(masks)} placeholders.")
            raise TranslationError(f"Ollama translation corrupted placeholder tokens for target {tgt_lang}")

        unmasked_text = unmask_text(cleaned_raw, masks)
        return unmasked_text

    async def validate_translation(
        self,
        original_text: str,
        translated_text: str,
        target_lang: str,
        request_id: str = "",
    ) -> tuple[bool, str]:
        """Validates translation using script checks, Devanagari Hindi vs Marathi marker discrimination,
        and numeric clinical entity preservation.
        """
        if not translated_text or not translated_text.strip():
            return False, "Translated text is empty."

        canonical = self.canonical_language_name(target_lang)
        if canonical == "english":
            return True, "OK"

        # Character script ratio evaluation
        devanagari_count = len(re.findall(r'[\u0900-\u097F]', translated_text))
        gujarati_count = len(re.findall(r'[\u0A80-\u0AFF]', translated_text))
        tamil_count = len(re.findall(r'[\u0B80-\u0BFF]', translated_text))
        latin_count = len(re.findall(r'[a-zA-Z]', translated_text))

        if canonical == "gujarati":
            target_count = gujarati_count
        elif canonical == "tamil":
            target_count = tamil_count
        elif canonical in ("hindi", "marathi"):
            target_count = devanagari_count
        else:
            target_count = devanagari_count + gujarati_count + tamil_count

        total_alpha = target_count + latin_count
        if total_alpha > 0:
            script_ratio = target_count / total_alpha
            if script_ratio < 0.30:
                return False, f"Insufficient target script ratio ({script_ratio:.2f}) for language {canonical}"

        # Requirement 9: Language-aware Hindi vs Marathi discrimination
        if canonical in ("hindi", "marathi"):
            words = set(re.findall(r'[\u0900-\u097F]+', translated_text))
            mr_matches = len(words.intersection(MARATHI_MARKERS))
            hi_matches = len(words.intersection(HINDI_MARKERS))

            detected_lang = None
            if self.language_detection and getattr(self.language_detection, "is_warm", False):
                try:
                    detected_lang = await self.language_detection.detect_language(translated_text)
                except Exception as e:
                    logger.debug(f"[TranslationService] Language detection service error: {e}")

            if canonical == "marathi":
                if detected_lang == "hindi" and mr_matches == 0 and hi_matches >= 2:
                    return False, f"Language check failed: Output identified as Hindi instead of Marathi (mr_markers={mr_matches}, hi_markers={hi_matches})"
                if mr_matches == 0 and hi_matches >= 3:
                    return False, f"Lexical markers indicate Hindi rather than Marathi (mr_markers={mr_matches}, hi_markers={hi_matches})"

            if canonical == "hindi":
                if detected_lang == "marathi" and hi_matches == 0 and mr_matches >= 2:
                    return False, f"Language check failed: Output identified as Marathi instead of Hindi (mr_markers={mr_matches}, hi_markers={hi_matches})"
                if hi_matches == 0 and mr_matches >= 3:
                    return False, f"Lexical markers indicate Marathi rather than Hindi (mr_markers={mr_matches}, hi_markers={hi_matches})"

        # Verify clinical numbers/dosages preservation
        original_numbers = set(re.findall(r'\b\d+(?:\.\d+)?\b', original_text))
        # Check numbers with >1 digit or decimals (e.g. 500, 25, 120, 80, 1.5)
        significant_numbers = {n for n in original_numbers if len(n) > 1 or '.' in n}
        if significant_numbers:
            translated_numbers = set(re.findall(r'\b\d+(?:\.\d+)?\b', translated_text))
            missing_numbers = significant_numbers - translated_numbers
            if len(missing_numbers) > max(1, len(significant_numbers) // 2):
                return False, f"Significant clinical numbers missing in translation: {missing_numbers}"

        return True, "OK"

    async def translate_with_metadata(
        self,
        text: str,
        src_lang: str,
        tgt_lang: str,
    ) -> dict[str, Any]:
        """Translates text and returns explicit translation metadata:
        {
            "translated_text": str,
            "provider": "indictrans2" | "ollama" | "none",
            "status": "SUCCESS" | "FALLBACK_ORIGINAL" | "FAILED",
            "target_language": str,
            "error": str | None
        }
        """
        request_id = str(uuid.uuid4())[:8]
        canonical_target = self.canonical_language_name(tgt_lang)
        canonical_src = self.canonical_language_name(src_lang)

        if not text or not text.strip():
            return {
                "translated_text": text,
                "provider": "none",
                "status": "SUCCESS",
                "target_language": canonical_target,
                "error": None,
            }

        if canonical_target == canonical_src or canonical_target == "english":
            return {
                "translated_text": text,
                "provider": "none",
                "status": "SUCCESS",
                "target_language": canonical_target,
                "error": None,
            }

        configured_provider = getattr(self.settings, "translation_provider", "auto").lower()
        last_error: str | None = None

        # 1. Primary path: IndicTrans2 (if provider is 'auto' or 'indictrans2')
        if configured_provider in ("auto", "indictrans2") and self.is_en_indic_warm:
            try:
                logger.info(f"[TranslationService][{request_id}] Attempting primary translation via IndicTrans2 to {canonical_target}")
                cand_text = await self._translate_with_indictrans2(text, canonical_src, canonical_target, request_id)
                valid, reason = await self.validate_translation(text, cand_text, canonical_target, request_id)
                if valid:
                    return {
                        "translated_text": cand_text,
                        "provider": "indictrans2",
                        "status": "SUCCESS",
                        "target_language": canonical_target,
                        "error": None,
                    }
                logger.warning(f"[TranslationService][{request_id}] IndicTrans2 output failed validation: {reason}. Falling back...")
                last_error = f"IndicTrans2 validation failed: {reason}"
            except Exception as e:
                logger.warning(f"[TranslationService][{request_id}] IndicTrans2 translation failed: {e}. Falling back...")
                last_error = f"IndicTrans2 error: {e}"

        # 2. Fallback path: Ollama LLM
        if self.llm is not None:
            try:
                logger.info(f"[TranslationService][{request_id}] Attempting fallback translation via Ollama to {canonical_target}")
                cand_text = await self._translate_with_ollama(text, canonical_src, canonical_target, request_id)
                valid, reason = await self.validate_translation(text, cand_text, canonical_target, request_id)
                if valid:
                    return {
                        "translated_text": cand_text,
                        "provider": "ollama",
                        "status": "SUCCESS",
                        "target_language": canonical_target,
                        "error": None,
                    }
                logger.warning(f"[TranslationService][{request_id}] Ollama output failed validation: {reason}")
                last_error = f"Ollama validation failed: {reason}"
            except Exception as e:
                logger.error(f"[TranslationService][{request_id}] Ollama translation failed: {e}")
                last_error = f"Ollama error: {e}"

        # 3. Explicit fallback: Preserve English original and report FALLBACK_ORIGINAL
        logger.error(f"[TranslationService][{request_id}] All translation providers failed for target {canonical_target}. Preserving English text.")
        return {
            "translated_text": text,
            "provider": "none",
            "status": "FALLBACK_ORIGINAL",
            "target_language": "english",
            "error": last_error or "Translation unavailable",
        }

    async def translate(self, text: str, src_lang: str, tgt_lang: str) -> str:
        """Backward-compatible translation call recording metadata."""
        res = await self.translate_with_metadata(text, src_lang, tgt_lang)
        self.last_metadata = res
        return res["translated_text"]
