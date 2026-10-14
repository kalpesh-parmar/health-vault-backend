from __future__ import annotations

import asyncio
import logging
import os
import re
import uuid
from typing import TYPE_CHECKING

from app.core.errors import TranslationError

if TYPE_CHECKING:
    from app.settings import Settings

logger = logging.getLogger(__name__)


def mask_text(text: str) -> tuple[str, list[str]]:
    masks = []
    
    # Entity patterns to protect
    patterns = [
        ("email", r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}'),
        ("phone", r'\+?\d{1,4}[-.\s]?\d{3,5}[-.\s]?\d{3,5}(?:[-.\s]?\d{1,4})?'),
        ("date_named", r'(?i)\b\d{1,2}-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*-\d{2,4}\b'),
        ("date_slash", r'\b\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}\b'),
        ("range", r'(?i)\b\d+(?:\.\d+)?\s*(?:-|to)\s*\d+(?:\.\d+)?(?:\s*(?:%|(?:mg\/dL|g\/dL|µg\/dL|ug\/dL|mcg\/dL|mg\/L|mmol\/L|µmol\/L|umol\/L|uIU\/mL|mU\/L|IU\/mL|pg\/mL|ng\/mL|fL|pg|mg|ml|gm|mcg|iu)\b))?'),
        ("number_unit", r'(?i)\b\d+(?:\.\d+)?\s*(?:%|(?:mg\/dL|g\/dL|µg\/dL|ug\/dL|mcg\/dL|mg\/L|mmol\/L|µmol\/L|umol\/L|uIU\/mL|mU\/L|IU\/mL|pg\/mL|ng\/mL|fL|pg|mg|ml|gm|mcg|iu|mm\/hr|sec|seconds|min|minutes|hrs|hours|days|tablets|capsules|pills)\b)'),
        ("bp", r'(?i)\b\d{2,3}\/\d{2,3}(?:\s*mmHg)?\b'),
        ("blood", r'(?<![A-Za-z])(?:AB|A|B|O)[+-]'),
        ("medical_terms", r'(?i)\b(?:HbA1c|TSH|PT\/INR|INR|Hb|Hemoglobin|WBC|RBC|Platelet\s+Count|Platelets|Creatinine|LDL|HDL|VLDL|Cholesterol|Triglycerides|Bilirubin|Urea|BUN|Glucose|FBS|PPBS|RBS|SGOT|AST|SGPT|ALT|Alkaline\s+Phosphatase|ALP|Total\s+Protein|Albumin|Globulin|Calcium|Sodium|Potassium|Chloride|Uric\s+Acid|ESR|CRP|Vitamin\s+D|Vitamin\s+B12|Ferritin|Iron|TIBC|PSA|FT3|FT4|Troponin|D-Dimer|Metformin|Atorvastatin|Telmisartan|Amlodipine|Paracetamol|Azithromycin|Amoxicillin)\b'),
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
        placeholder = f"⟦{i + 1}⟧"
        final_text += placeholder
        masks.append(val)
        curr_idx = end
    final_text += text[curr_idx:]
    
    return final_text, masks


def unmask_text(masked_text: str, masks: list[str]) -> str:
    def replace_match(match: re.Match) -> str:
        try:
            idx = int(match.group(1)) - 1
            if 0 <= idx < len(masks):
                return masks[idx]
        except Exception:
            pass
        return ""
    
    pattern = r'⟦\s*(\d+)\s*⟧'
    unmasked = re.sub(pattern, replace_match, masked_text)
    return unmasked


def validate_placeholder_integrity(translated_text: str, expected_count: int) -> bool:
    if not translated_text:
        return expected_count == 0
    found = re.findall(r'⟦\s*(\d+)\s*⟧', translated_text)
    if len(found) != expected_count:
        return False
    for i in range(1, expected_count + 1):
        pattern = rf'⟦\s*{i}\s*⟧'
        if len(re.findall(pattern, translated_text)) != 1:
            return False
    return True


def split_sentences_clean(text: str) -> list[str]:
    if not text:
        return []
    protected = re.sub(r'\b(Dr|Mr|Mrs|Ms|Prof|Sr|Jr|Tab|Cap|Inj|vs|e\.g|i\.e)\.', r'\1⟦DOT⟧', text, flags=re.IGNORECASE)
    parts = re.split(r'(?<=[.!?;\n])\s+', protected)
    return [p.replace("⟦DOT⟧", ".").strip() for p in parts if p.strip()]



class TranslationService:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.en_indic_tokenizer = None
        self.en_indic_model = None
        self.indic_en_tokenizer = None
        self.indic_en_model = None
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
                en_indic_name = "ai4bharat/indictrans2-en-indic-dist-200M"
                indic_en_name = "ai4bharat/indictrans2-indic-en-dist-200M"
                self.device = "cuda" if torch.cuda.is_available() else "cpu"
                logger.info(f"[TranslationService] Device selected: {self.device}")

                kwargs = {}
                if Version(tf_version) >= Version("4.32"):
                    kwargs["token"] = resolved_token
                else:
                    kwargs["use_auth_token"] = resolved_token

                logger.info(f"[TranslationService] Loading {en_indic_name}...")
                self.en_indic_tokenizer = AutoTokenizer.from_pretrained(en_indic_name, trust_remote_code=True, **kwargs)
                self.en_indic_model = AutoModelForSeq2SeqLM.from_pretrained(
                    en_indic_name,
                    trust_remote_code=True,
                    **kwargs
                ).to(self.device)

                logger.info(f"[TranslationService] Loading {indic_en_name}...")
                self.indic_en_tokenizer = AutoTokenizer.from_pretrained(indic_en_name, trust_remote_code=True, **kwargs)
                self.indic_en_model = AutoModelForSeq2SeqLM.from_pretrained(
                    indic_en_name,
                    trust_remote_code=True,
                    **kwargs
                ).to(self.device)

                self.is_warm = True
                logger.info("[TranslationService] Translation models loaded successfully.")
            else:
                logger.warning("[TranslationService] Translation is disabled because HF_TOKEN is not configured.")
                self.is_warm = False

            self.ip = IndicProcessor(inference=True)
        except Exception as e:
            logger.error(f"[TranslationService] Failed to warm up translation model: {e}", exc_info=True)
            self.en_indic_tokenizer = None
            self.en_indic_model = None
            self.indic_en_tokenizer = None
            self.indic_en_model = None
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
            "tn": "tam_Taml",
        }
        return mapping.get(l_clean, "eng_Latn")

    def split_sentences(self, text: str) -> list[str]:
        sentences = re.split(r'(?<=[.!?])\s+', text)
        return [s.strip() for s in sentences if s.strip()]

    async def translate(self, text: str, src_lang: str, tgt_lang: str) -> str:
        request_id = str(uuid.uuid4())[:8]
        logger.info(f"[TranslationService][{request_id}] STEP 1 - Request received | src={src_lang}, tgt={tgt_lang}, length={len(text)} chars")
        if not text:
            return text
            
        if not self.is_warm:
            logger.warning(f"[TranslationService][{request_id}] Model not warm, returning original text")
            return text

        src_code = self.map_lang_code(src_lang)
        tgt_code = self.map_lang_code(tgt_lang)

        if src_code == tgt_code:
            logger.info(f"[TranslationService][{request_id}] Source and target languages are identical ({src_code}), skipping translation")
            return text

        if tgt_code == "eng_Latn":
            current_tokenizer = self.indic_en_tokenizer
            current_model = self.indic_en_model
        else:
            current_tokenizer = self.en_indic_tokenizer
            current_model = self.en_indic_model

        if current_model is None or current_tokenizer is None:
            logger.error(f"[TranslationService][{request_id}] Required translation model is not loaded for {src_code} -> {tgt_code}")
            return text

        logger.info(f"[TranslationService][{request_id}] STEP 2 - Preprocessing & masking started")
        masked_text, masks = mask_text(text)
        
        paragraphs = masked_text.split('\n')
        all_sentences = []
        sentence_to_para_map = []
        
        for i, para in enumerate(paragraphs):
            if not para.strip():
                continue
            sentences = self.split_sentences(para)
            for s in sentences:
                all_sentences.append(s)
                sentence_to_para_map.append(i)
                
        if not all_sentences:
            logger.warning(f"[TranslationService][{request_id}] No sentences to translate after preprocessing")
            return text

        total_sentences = len(all_sentences)
        batch_size = 4
        total_batches = (total_sentences + batch_size - 1) // batch_size
        logger.info(f"[TranslationService][{request_id}] STEP 3 - Preprocessing completed: {total_sentences} sentences in {len(paragraphs)} paragraph(s), total {total_batches} batch(es)")

        try:
            import torch
            import time
            start_time = time.time()
            translated_sentences = []
            
            logger.info(f"[TranslationService][{request_id}] STEP 4 - Waiting to acquire translation lock for request...")
            lock_start = time.time()
            async with self._lock:
                logger.info(f"[TranslationService][{request_id}] STEP 5 - Lock acquired after {time.time() - lock_start:.2f}s. Starting batch processing...")
                
                for i in range(0, total_sentences, batch_size):
                    batch_num = (i // batch_size) + 1
                    sentence_batch = all_sentences[i:i + batch_size]
                    logger.info(f"[TranslationService][{request_id}] STEP 6 - Preparing batch {batch_num}/{total_batches} ({len(sentence_batch)} sentences)")
                    
                    batch = self.ip.preprocess_batch(sentence_batch, src_lang=src_code, tgt_lang=tgt_code)
                    
                    inputs = current_tokenizer(
                        batch,
                        truncation=True,
                        padding="longest",
                        return_tensors="pt"
                    ).to(self.device)

                    loop = asyncio.get_running_loop()
                    
                    def _generate(inputs_arg=inputs, model_arg=current_model):
                        gen_start = time.time()
                        with torch.no_grad():
                            res = model_arg.generate(
                                **inputs_arg,
                                use_cache=False,
                                min_length=0,
                                max_length=256,
                                num_beams=self.settings.translation_num_beams,
                                num_return_sequences=1
                            )
                        gen_duration = time.time() - gen_start
                        logger.info(f"[TranslationService][{request_id}] PyTorch model.generate() finished in {gen_duration:.2f}s for batch {batch_num}/{total_batches}")
                        return res
                        
                    generated_tokens = await loop.run_in_executor(None, _generate)

                    decoded = current_tokenizer.batch_decode(generated_tokens, skip_special_tokens=True)
                    postprocessed = self.ip.postprocess_batch(decoded, lang=tgt_code)
                    translated_sentences.extend(postprocessed)
                    logger.info(f"[TranslationService][{request_id}] Completed batch {batch_num}/{total_batches}")

            logger.info(f"[TranslationService][{request_id}] STEP 7 - Lock released. Reassembling paragraphs and unmasking...")
            translated_paragraphs = [""] * len(paragraphs)
            for i, translated_sent in zip(sentence_to_para_map, translated_sentences):
                if translated_paragraphs[i]:
                    translated_paragraphs[i] += " " + translated_sent
                else:
                    translated_paragraphs[i] = translated_sent
                    
            translated_text = "\n".join(translated_paragraphs)
            unmasked_text = unmask_text(translated_text, masks)
            
            end_time = time.time()
            logger.info(f"[TranslationService][{request_id}] SUCCESS - Translated {len(text)} chars ({total_sentences} sentences) from {src_lang} to {tgt_lang} in {end_time - start_time:.2f} seconds")
            return unmasked_text
        except Exception as e:
            logger.error(f"[TranslationService][{request_id}] Error during translation: {e}", exc_info=True)
            raise TranslationError(f"Translation failed: {e}") from e
