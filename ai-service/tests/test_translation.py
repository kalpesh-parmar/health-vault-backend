from __future__ import annotations

import os
from unittest.mock import MagicMock, patch
import pytest
from packaging.version import Version

from app.settings import Settings
from app.services.translation_service import TranslationService

class DummySettings:
    def __init__(self, hf_token=None):
        self.hf_token = hf_token
        self.translation_model_name = "ai4bharat/indictrans2-en-indic-dist-200M"
        self.translation_num_beams = 1


@pytest.fixture
def mock_transformers():
    with patch("transformers.AutoTokenizer.from_pretrained") as mock_tok, \
         patch("transformers.AutoModelForSeq2SeqLM.from_pretrained") as mock_model, \
         patch("IndicTransToolkit.processor.IndicProcessor") as mock_proc:
        yield mock_tok, mock_model, mock_proc


@pytest.mark.asyncio
async def test_warmup_no_token(mock_transformers) -> None:
    mock_tok, mock_model, mock_proc = mock_transformers
    settings = DummySettings(hf_token=None)
    
    # Ensure no environment variable overrides
    with patch.dict(os.environ, {}, clear=True):
        service = TranslationService(settings)
        await service.warm_up()
        
        # Verify from_pretrained was never called
        mock_tok.assert_not_called()
        mock_model.assert_not_called()
        
        # Verify IndicProcessor is still initialized (since it's independent)
        mock_proc.assert_called_once_with(inference=True)
        
        # Verify is_warm is False
        assert service.is_warm is False
        
        # Verify fallback translation (returns original text)
        result = await service.translate("Hello World", "en", "gu")
        assert result == "Hello World"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "tf_version, expected_key",
    [
        ("4.31.0", "use_auth_token"),
        ("4.32.0", "token"),
        ("4.38.0", "token"),
        ("5.0.0", "token"),
    ],
)
async def test_warmup_with_token_version_check(mock_transformers, tf_version, expected_key) -> None:
    mock_tok, mock_model, mock_proc = mock_transformers
    
    # Mocking version info
    with patch("transformers.__version__", tf_version):
        settings = DummySettings(hf_token="test_huggingface_token")
        service = TranslationService(settings)
        
        # Set up mock returns
        fake_model = MagicMock()
        mock_model.return_value.to.return_value = fake_model
        
        await service.warm_up()
        
        # Verify tokenizer loading used the correct argument name
        mock_tok.assert_called_once()
        _, kwargs_tok = mock_tok.call_args
        assert kwargs_tok.get(expected_key) == "test_huggingface_token"
        assert kwargs_tok.get("trust_remote_code") is True
        
        # Verify model loading used the correct argument name
        mock_model.assert_called_once()
        _, kwargs_model = mock_model.call_args
        assert kwargs_model.get(expected_key) == "test_huggingface_token"
        assert kwargs_model.get("trust_remote_code") is True
        
        # Verify IndicProcessor is initialized
        mock_proc.assert_called_once_with(inference=True)
        
        # Verify is_warm is True
        assert service.is_warm is True
