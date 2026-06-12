from __future__ import annotations

import asyncio
from pathlib import Path


class VoiceService:
    def __init__(self, whisper_model: str, tts_model_name: str) -> None:
        from faster_whisper import WhisperModel
        from TTS.api import TTS

        self.whisper = WhisperModel(whisper_model, device="auto", compute_type="auto")
        self.tts = TTS(tts_model_name)

    async def transcribe_file(self, audio_path: Path) -> str:
        def run() -> str:
            segments, _ = self.whisper.transcribe(str(audio_path), vad_filter=True)
            return " ".join(segment.text.strip() for segment in segments)

        return await asyncio.to_thread(run)

    async def synthesize_to_file(self, text: str, output_path: Path) -> Path:
        def run() -> Path:
            output_path.parent.mkdir(parents=True, exist_ok=True)
            self.tts.tts_to_file(text=text, file_path=str(output_path))
            return output_path

        return await asyncio.to_thread(run)

