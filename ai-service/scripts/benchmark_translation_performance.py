from __future__ import annotations

import asyncio
import gc
import json
import os
import re
import sys
import time
from typing import Any

import psutil
import torch

# Ensure ai-service is in sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.settings import Settings
from app.services.translation_service import (
    TranslationService,
    mask_text,
    unmask_text,
    validate_placeholder_integrity,
    split_sentences_clean,
    _patch_decoder_for_transformers_cache,
)
from app.services.llm import LLMService
from app.services.language_detection_service import LanguageDetectionService

# Synthetic medical summaries strictly devoid of any real PHI
SYNTHETIC_SUMMARIES = {
    "short": (
        "Patient diagnosed with acute bronchitis. "
        "Prescribed Azithromycin 500mg once daily for 3 days and Paracetamol 650mg as needed for fever."
    ),
    "medium": (
        "Patient presents for routine follow-up of Type 2 Diabetes Mellitus and Essential Hypertension. "
        "Laboratory results reveal HbA1c at 7.8% and fasting blood sugar at 138 mg/dL. "
        "Blood pressure reading is 135/85 mmHg. "
        "Current medications include Metformin 500mg twice daily after meals (1-0-1) and Telmisartan 40mg once daily in the morning."
    ),
    "long": (
        "The patient is a 62-year-old male presenting with chronic generalized fatigue, bilateral lower extremity edema, and exertional dyspnea. "
        "Comprehensive clinical evaluation confirms decompensated congestive heart failure and Stage 3 Chronic Kidney Disease. "
        "Relevant laboratory findings indicate Serum Creatinine at 2.1 mg/dL, Blood Urea Nitrogen at 38 mg/dL, and Serum Potassium at 4.9 mEq/L. "
        "Electrocardiogram demonstrates sinus rhythm with left ventricular hypertrophy. "
        "Prescribed medical regimen includes Furosemide 40mg once daily in the morning (1-0-0), Spironolactone 25mg once daily, and Carvedilol 6.25mg twice daily with meals (1-0-1). "
        "The patient is advised strict dietary sodium restriction below 2000mg per day and daily fluid intake limited to 1.5 liters. "
        "Repeat renal panel and serum electrolytes scheduled in 14 days."
    ),
}

LANGUAGES = ["gujarati", "hindi", "marathi", "tamil"]


def get_process_memory_mb() -> float:
    process = psutil.Process(os.getpid())
    return process.memory_info().rss / (1024 * 1024)


async def benchmark_model_load(settings: Settings) -> dict[str, Any]:
    print("\n========================================================")
    print("PHASE 2.1: BENCHMARKING MODEL INITIALIZATION & LOADING")
    print("========================================================")
    gc.collect()
    mem_before = get_process_memory_mb()
    print(f"Memory before model load: {mem_before:.2f} MB")

    from transformers import AutoModelForSeq2SeqLM, AutoTokenizer
    from IndicTransToolkit.processor import IndicProcessor

    t0 = time.perf_counter()
    en_indic_name = "ai4bharat/indictrans2-en-indic-dist-200M"
    print(f"Loading {en_indic_name}...")
    t_tok0 = time.perf_counter()
    tokenizer = AutoTokenizer.from_pretrained(en_indic_name, trust_remote_code=True)
    t_tok = (time.perf_counter() - t_tok0) * 1000

    t_mod0 = time.perf_counter()
    model = AutoModelForSeq2SeqLM.from_pretrained(en_indic_name, trust_remote_code=True).to("cpu")
    _patch_decoder_for_transformers_cache(model)
    t_mod = (time.perf_counter() - t_mod0) * 1000

    t_ip0 = time.perf_counter()
    ip = IndicProcessor(inference=True)
    t_ip = (time.perf_counter() - t_ip0) * 1000

    en_indic_total = (time.perf_counter() - t0) * 1000
    mem_after_en_indic = get_process_memory_mb()
    print(f"En->Indic loaded: tokenizer={t_tok:.1f}ms, model={t_mod:.1f}ms, IndicProcessor={t_ip:.1f}ms, total={en_indic_total:.1f}ms")
    print(f"Memory after En->Indic: {mem_after_en_indic:.2f} MB (+{mem_after_en_indic - mem_before:.2f} MB)")

    # Test Indic->En load attempt (to measure whether it stalls or fails due to network)
    indic_en_name = "ai4bharat/indictrans2-indic-en-dist-200M"
    print(f"Testing {indic_en_name} load attempt (un-cached probe)...")
    t_ie0 = time.perf_counter()
    indic_en_status = "NOT_ATTEMPTED"
    try:
        AutoTokenizer.from_pretrained(indic_en_name, trust_remote_code=True, local_files_only=True)
        indic_en_status = "LOCAL_CACHE_FOUND"
    except Exception as e:
        indic_en_status = f"MISSING_LOCALLY ({type(e).__name__})"
    t_ie = (time.perf_counter() - t_ie0) * 1000
    print(f"Indic->En local check: {indic_en_status} in {t_ie:.1f}ms")

    # Benchmark FastText language detection loading
    t_ld0 = time.perf_counter()
    ld = LanguageDetectionService()
    await ld.warm_up()
    t_ld = (time.perf_counter() - t_ld0) * 1000
    print(f"FastText GlotLID language detection warm_up: {t_ld:.1f}ms, warm={ld.is_warm}")

    return {
        "en_indic_tokenizer_ms": t_tok,
        "en_indic_model_ms": t_mod,
        "indic_processor_ms": t_ip,
        "en_indic_total_ms": en_indic_total,
        "indic_en_check_ms": t_ie,
        "indic_en_status": indic_en_status,
        "language_detection_load_ms": t_ld,
        "mem_delta_mb": mem_after_en_indic - mem_before,
        "model": model,
        "tokenizer": tokenizer,
        "ip": ip,
        "ld": ld,
    }


async def benchmark_single_indictrans2(
    text: str,
    target_lang: str,
    loaded_components: dict[str, Any],
    use_cache: bool = False,
) -> dict[str, Any]:
    model = loaded_components["model"]
    tokenizer = loaded_components["tokenizer"]
    ip = loaded_components["ip"]
    ld = loaded_components["ld"]

    lang_map = {
        "gujarati": "guj_Gujr",
        "hindi": "hin_Deva",
        "marathi": "mar_Deva",
        "tamil": "tam_Taml",
    }
    src_code = "eng_Latn"
    tgt_code = lang_map.get(target_lang, "hin_Deva")

    t_total0 = time.perf_counter()

    # 1. Sentence splitting
    t_split0 = time.perf_counter()
    paragraphs = text.split("\n")
    all_sentences: list[str] = []
    sentence_to_para_map: list[int] = []
    for i, para in enumerate(paragraphs):
        if not para.strip():
            continue
        for s in split_sentences_clean(para):
            all_sentences.append(s)
            sentence_to_para_map.append(i)
    t_split = (time.perf_counter() - t_split0) * 1000

    # 2. Tokenization & Preprocessing
    t_tok0 = time.perf_counter()
    batch_size = 4
    translated_sentences = []
    total_input_tokens = 0
    total_generated_tokens = 0
    t_infer_accum = 0.0
    t_post_accum = 0.0

    for i in range(0, len(all_sentences), batch_size):
        s_batch = all_sentences[i:i + batch_size]
        p_batch = ip.preprocess_batch(s_batch, src_lang=src_code, tgt_lang=tgt_code)
        inputs = tokenizer(p_batch, truncation=True, padding="longest", return_tensors="pt")
        total_input_tokens += inputs["input_ids"].numel()

        t_inf0 = time.perf_counter()
        with torch.no_grad():
            gen_tokens = model.generate(
                **inputs,
                use_cache=use_cache,
                min_length=0,
                max_length=256,
                num_beams=1,
                num_return_sequences=1,
            )
        t_infer_accum += (time.perf_counter() - t_inf0) * 1000
        total_generated_tokens += gen_tokens.numel()

        t_post0 = time.perf_counter()
        decoded = tokenizer.batch_decode(gen_tokens, skip_special_tokens=True)
        postproc = ip.postprocess_batch(decoded, lang=tgt_code)
        translated_sentences.extend(postproc)
        t_post_accum += (time.perf_counter() - t_post0) * 1000

    t_tok = (time.perf_counter() - t_tok0) * 1000 - t_infer_accum - t_post_accum

    # Reconstruct paragraphs
    translated_paragraphs = [""] * len(paragraphs)
    for p_idx, s_trans in zip(sentence_to_para_map, translated_sentences):
        if translated_paragraphs[p_idx]:
            translated_paragraphs[p_idx] += " " + s_trans
        else:
            translated_paragraphs[p_idx] = s_trans
    translated_text = "\n".join(translated_paragraphs)

    # 3. Validation
    t_val0 = time.perf_counter()
    # Script check & Marker check
    canonical = target_lang
    devanagari_count = len(re.findall(r'[\u0900-\u097F]', translated_text))
    gujarati_count = len(re.findall(r'[\u0A80-\u0AFF]', translated_text))
    tamil_count = len(re.findall(r'[\u0B80-\u0BFF]', translated_text))
    latin_count = len(re.findall(r'[a-zA-Z]', translated_text))

    if canonical == "gujarati":
        target_count = gujarati_count
    elif canonical == "tamil":
        target_count = tamil_count
    else:
        target_count = devanagari_count

    total_alpha = target_count + latin_count
    script_ratio = (target_count / total_alpha) if total_alpha > 0 else 1.0

    # FastText Language Detection
    t_fasttext0 = time.perf_counter()
    detected_lang = None
    if ld and ld.is_warm:
        detected_lang = await ld.detect_language(translated_text)
    t_fasttext = (time.perf_counter() - t_fasttext0) * 1000

    # Numbers check
    original_numbers = set(re.findall(r'\b\d+(?:\.\d+)?\b', text))
    significant_numbers = {n for n in original_numbers if len(n) > 1 or '.' in n}
    translated_numbers = set(re.findall(r'\b\d+(?:\.\d+)?\b', translated_text))
    missing_numbers = significant_numbers - translated_numbers
    numbers_preserved = len(missing_numbers) == 0

    t_val = (time.perf_counter() - t_val0) * 1000
    t_total = (time.perf_counter() - t_total0) * 1000

    tokens_per_sec = (total_generated_tokens / (t_infer_accum / 1000.0)) if t_infer_accum > 0 else 0

    return {
        "text_chars": len(text),
        "translated_chars": len(translated_text),
        "sentence_count": len(all_sentences),
        "input_tokens": total_input_tokens,
        "output_tokens": total_generated_tokens,
        "tokens_per_sec": tokens_per_sec,
        "split_sentences_ms": t_split,
        "tokenization_preprocess_ms": t_tok,
        "inference_ms": t_infer_accum,
        "decode_postprocess_ms": t_post_accum,
        "validation_ms": t_val,
        "fasttext_ms": t_fasttext,
        "total_ms": t_total,
        "script_ratio": script_ratio,
        "detected_lang": detected_lang,
        "numbers_preserved": numbers_preserved,
        "translated_preview": translated_text[:120],
        "use_cache": use_cache,
    }


async def benchmark_single_ollama(
    text: str,
    target_lang: str,
    llm: LLMService,
    model_name: str = "qwen2.5:14b",
) -> dict[str, Any]:
    t0 = time.perf_counter()

    t_mask0 = time.perf_counter()
    masked_text, masks = mask_text(text)
    t_mask = (time.perf_counter() - t_mask0) * 1000

    target_canonical = target_lang.capitalize()
    system_instruction = (
        f"You are a professional medical translator. Translate the following clinical summary into {target_canonical}.\n"
        "MANDATORY RULES:\n"
        "1. Preserve all placeholders like ⟦1⟧, ⟦2⟧ EXACTLY as they appear without any translation, spacing change, or alteration.\n"
        "2. Translate all surrounding clinical text accurately, naturally, and grammatically.\n"
        "3. Preserve all medicine names, dosages, frequencies, and lab parameters exactly.\n"
        "4. NEVER invent or hallucinate clinical details, treatments, or medication schedules.\n"
        "5. Output ONLY the translated text. Do not provide commentary, notes, or explanations."
    )

    t_call0 = time.perf_counter()
    resp = await llm.chat(
        messages=[
            {"role": "system", "content": system_instruction},
            {"role": "user", "content": masked_text},
        ],
        model=model_name,
        temperature=0.0,
        num_predict=1024,
    )
    t_call = (time.perf_counter() - t_call0) * 1000

    t_unmask0 = time.perf_counter()
    cleaned = re.sub(r"<(?:think|thinking|reasoning)\b[^>]*>[\s\S]*?</(?:think|thinking|reasoning)>", "", resp, flags=re.IGNORECASE).strip()
    valid_placeholders = validate_placeholder_integrity(cleaned, len(masks))
    unmasked = unmask_text(cleaned, masks)
    t_unmask = (time.perf_counter() - t_unmask0) * 1000

    t_total = (time.perf_counter() - t0) * 1000

    # Numbers check
    original_numbers = set(re.findall(r'\b\d+(?:\.\d+)?\b', text))
    significant_numbers = {n for n in original_numbers if len(n) > 1 or '.' in n}
    translated_numbers = set(re.findall(r'\b\d+(?:\.\d+)?\b', unmasked))
    missing_numbers = significant_numbers - translated_numbers

    return {
        "text_chars": len(text),
        "translated_chars": len(unmasked),
        "mask_count": len(masks),
        "mask_ms": t_mask,
        "ollama_api_call_ms": t_call,
        "unmask_ms": t_unmask,
        "total_ms": t_total,
        "placeholders_valid": valid_placeholders,
        "numbers_preserved": len(missing_numbers) == 0,
        "translated_preview": unmasked[:120],
    }


async def main():
    settings = Settings()
    llm = LLMService(
        api_key=settings.ai_api_key,
        base_url=settings.ai_base_url,
        model=settings.ai_model,
        timeout_seconds=settings.ai_timeout_seconds,
        max_retries=settings.ai_max_retries,
        max_output_tokens=settings.ai_max_output_tokens,
        keep_alive=getattr(settings, "ollama_keep_alive", "10m"),
    )

    # 1. Benchmark Model Load & Hardware
    load_metrics = await benchmark_model_load(settings)

    # 2. Benchmark IndicTrans2 Across Languages & Lengths
    print("\n========================================================")
    print("PHASE 2.2 & PHASE 3: LIVE BENCHMARKING INDICTRANS2 (CPU)")
    print("========================================================")

    results_indictrans = {}

    for length in ["short", "medium", "long"]:
        text = SYNTHETIC_SUMMARIES[length]
        results_indictrans[length] = {}
        print(f"\n--- Summary Length: {length.upper()} ({len(text)} chars) ---")

        for lang in LANGUAGES:
            print(f"Testing {lang.capitalize()}...")
            # Cold run (first run for this language/length)
            cold_res = await benchmark_single_indictrans2(text, lang, load_metrics, use_cache=False)

            # 3 Warm runs
            warm_runs = []
            for r in range(3):
                w_res = await benchmark_single_indictrans2(text, lang, load_metrics, use_cache=False)
                warm_runs.append(w_res)

            warm_totals = [w["total_ms"] for w in warm_runs]
            warm_totals.sort()
            median_warm = warm_totals[1]
            max_warm = warm_totals[2]

            results_indictrans[length][lang] = {
                "cold": cold_res,
                "warm_runs": warm_runs,
                "median_warm_ms": median_warm,
                "max_warm_ms": max_warm,
            }
            print(
                f"  -> Cold: {cold_res['total_ms']:.1f}ms | "
                f"Warm Median: {median_warm:.1f}ms | Max: {max_warm:.1f}ms | "
                f"Tokens/s: {warm_runs[1]['tokens_per_sec']:.1f} | "
                f"Validation: {cold_res['validation_ms']:.1f}ms | Numbers Preserved: {cold_res['numbers_preserved']}"
            )

    # 2b. Ablation: Test use_cache=True vs use_cache=False on Medium Summary
    print("\n--- Ablation: Evaluating impact of KV-Cache (use_cache=True vs False) ---")
    med_text = SYNTHETIC_SUMMARIES["medium"]
    no_cache_res = await benchmark_single_indictrans2(med_text, "gujarati", load_metrics, use_cache=False)
    cache_res = await benchmark_single_indictrans2(med_text, "gujarati", load_metrics, use_cache=True)
    print(f"Medium Gujarati (use_cache=False): inference={no_cache_res['inference_ms']:.1f}ms, total={no_cache_res['total_ms']:.1f}ms")
    print(f"Medium Gujarati (use_cache=True):  inference={cache_res['inference_ms']:.1f}ms, total={cache_res['total_ms']:.1f}ms")
    cache_speedup = ((no_cache_res['inference_ms'] - cache_res['inference_ms']) / no_cache_res['inference_ms']) * 100
    print(f"KV-Cache Speedup: {cache_speedup:.1f}%")

    # 3. Benchmark Ollama qwen2.5:14b
    print("\n========================================================")
    print("PHASE 3.2: LIVE BENCHMARKING OLLAMA (qwen2.5:14b)")
    print("========================================================")
    results_ollama = {}
    for length in ["short", "medium", "long"]:
        text = SYNTHETIC_SUMMARIES[length]
        results_ollama[length] = {}
        print(f"\n--- Ollama Summary Length: {length.upper()} ({len(text)} chars) ---")

        for lang in LANGUAGES:
            print(f"Testing Ollama {lang.capitalize()}...")
            try:
                cold_res = await benchmark_single_ollama(text, lang, llm, "qwen2.5:14b")
                warm_runs = []
                for _ in range(3):
                    w_res = await benchmark_single_ollama(text, lang, llm, "qwen2.5:14b")
                    warm_runs.append(w_res)

                warm_totals = [w["total_ms"] for w in warm_runs]
                warm_totals.sort()
                median_warm = warm_totals[1]
                max_warm = warm_totals[2]

                results_ollama[length][lang] = {
                    "cold": cold_res,
                    "warm_runs": warm_runs,
                    "median_warm_ms": median_warm,
                    "max_warm_ms": max_warm,
                }
                print(
                    f"  -> Cold: {cold_res['total_ms']:.1f}ms | "
                    f"Warm Median: {median_warm:.1f}ms | Max: {max_warm:.1f}ms | "
                    f"Placeholders Valid: {cold_res['placeholders_valid']} | Numbers Preserved: {cold_res['numbers_preserved']}"
                )
            except Exception as e:
                print(f"  -> Ollama failed: {e}")
                results_ollama[length][lang] = {"error": str(e)}

    # Save complete benchmark payload to disk
    out_path = os.path.join(os.path.dirname(__file__), "translation_benchmark_results.json")
    # Clean up non-serializable objects
    del load_metrics["model"]
    del load_metrics["tokenizer"]
    del load_metrics["ip"]
    del load_metrics["ld"]

    summary_payload = {
        "load_metrics": load_metrics,
        "indictrans2_results": results_indictrans,
        "indictrans2_kv_cache_ablation": {
            "use_cache_false_ms": no_cache_res["total_ms"],
            "use_cache_true_ms": cache_res["total_ms"],
            "speedup_percent": cache_speedup,
        },
        "ollama_results": results_ollama,
    }

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(summary_payload, f, indent=2)

    print(f"\nBenchmark completed successfully! Results written to {out_path}")
    await llm.close()


if __name__ == "__main__":
    asyncio.run(main())
