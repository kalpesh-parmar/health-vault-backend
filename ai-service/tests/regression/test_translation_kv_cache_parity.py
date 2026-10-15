from __future__ import annotations

import os
import re
import pytest
import torch

from app.settings import Settings
from app.services.translation_service import (
    TranslationService,
    split_sentences_clean,
    _patch_decoder_for_transformers_cache,
)

SYNTHETIC_MEDICAL_CASES = [
    {
        "id": "short_bronchitis",
        "text": "Patient diagnosed with acute bronchitis. Prescribed Azithromycin 500mg once daily for 3 days and Paracetamol 650mg as needed for fever.",
        "expected_numbers": ["500", "3", "650"],
    },
    {
        "id": "medium_metabolic",
        "text": (
            "Patient presents for routine follow-up of Type 2 Diabetes Mellitus and Essential Hypertension. "
            "Laboratory results reveal HbA1c at 7.8% and fasting blood sugar at 138 mg/dL. "
            "Blood pressure reading is 135/85 mmHg. "
            "Current medications include Metformin 500mg twice daily after meals (1-0-1) and Telmisartan 40mg once daily in the morning."
        ),
        "expected_numbers": ["7.8", "138", "135", "85", "500", "40"],
    },
]

LANGUAGES = ["gujarati", "hindi", "marathi", "tamil"]


@pytest.fixture(scope="module")
def initialized_translation_service():
    """Initializes TranslationService using local weights and patched decoder."""
    settings = Settings()
    service = TranslationService(settings)
    
    # Load model synchronously for tests
    from transformers import AutoModelForSeq2SeqLM, AutoTokenizer
    from IndicTransToolkit.processor import IndicProcessor

    en_indic_name = "ai4bharat/indictrans2-en-indic-dist-200M"
    try:
        service.en_indic_tokenizer = AutoTokenizer.from_pretrained(
            en_indic_name,
            trust_remote_code=True,
            local_files_only=True,
        )
        model = AutoModelForSeq2SeqLM.from_pretrained(
            en_indic_name,
            trust_remote_code=True,
            local_files_only=True,
        ).to("cpu")
        _patch_decoder_for_transformers_cache(model)
        service.en_indic_model = model
        service.ip = IndicProcessor(inference=True)
        service.is_en_indic_warm = True
        service.is_warm = True
    except Exception as exc:
        pytest.skip(f"IndicTrans2 local model weights not available: {exc}")

    return service


@pytest.mark.parametrize("case", SYNTHETIC_MEDICAL_CASES, ids=lambda c: c["id"])
@pytest.mark.parametrize("lang", LANGUAGES)
def test_kv_cache_parity_and_numeric_preservation(initialized_translation_service, case, lang):
    """Verifies that use_cache=True generates output identical to use_cache=False,
    and preserves all critical clinical numbers, dosages, and units.
    """
    service = initialized_translation_service
    src_code = "eng_Latn"
    tgt_code = service.map_lang_code(lang)
    text = case["text"]
    expected_numbers = case["expected_numbers"]

    all_sentences = split_sentences_clean(text)

    # 1. Generate with use_cache=False
    batch_no_cache = service.ip.preprocess_batch(all_sentences, src_lang=src_code, tgt_lang=tgt_code)
    inputs_no_cache = service.en_indic_tokenizer(batch_no_cache, truncation=True, padding="longest", return_tensors="pt")
    with torch.no_grad():
        tokens_no_cache = service.en_indic_model.generate(
            **inputs_no_cache,
            use_cache=False,
            min_length=0,
            max_length=256,
            num_beams=1,
            num_return_sequences=1,
        )
    decoded_no_cache = service.en_indic_tokenizer.batch_decode(tokens_no_cache, skip_special_tokens=True)
    post_no_cache = service.ip.postprocess_batch(decoded_no_cache, lang=tgt_code)
    text_no_cache = " ".join(post_no_cache)

    # 2. Generate with use_cache=True (replenish IndicProcessor queue via preprocess_batch)
    batch_with_cache = service.ip.preprocess_batch(all_sentences, src_lang=src_code, tgt_lang=tgt_code)
    inputs_with_cache = service.en_indic_tokenizer(batch_with_cache, truncation=True, padding="longest", return_tensors="pt")
    with torch.no_grad():
        tokens_with_cache = service.en_indic_model.generate(
            **inputs_with_cache,
            use_cache=True,
            min_length=0,
            max_length=256,
            num_beams=1,
            num_return_sequences=1,
        )
    decoded_with_cache = service.en_indic_tokenizer.batch_decode(tokens_with_cache, skip_special_tokens=True)
    post_with_cache = service.ip.postprocess_batch(decoded_with_cache, lang=tgt_code)
    text_with_cache = " ".join(post_with_cache)

    # Output parity verification: tokens generated must match
    assert text_with_cache == text_no_cache, (
        f"KV-cache mismatch for {lang}:\n"
        f"With cache:    {text_with_cache}\n"
        f"Without cache: {text_no_cache}"
    )

    # Verify critical clinical numbers are preserved in translated output
    for num in expected_numbers:
        assert num in text_with_cache, f"Clinical number {num} missing in {lang} translation: {text_with_cache}"
