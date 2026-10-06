import unittest
from app.core.logging_redaction import redact_sensitive_data


class TestLoggingRedaction(unittest.TestCase):
    def test_redacts_patient_identifiers(self):
        payload = {
            "patientName": "Jane Doe",
            "patient_name": "Jane Doe",
            "firstName": "Jane",
            "lastName": "Doe",
            "phone": "+91 9876543210",
            "email": "patient@example.com",
            "caseId": "CASE-123",
            "uhid": "UHID-456",
            "doctorName": "Dr. Smith",
        }
        cleaned = redact_sensitive_data(payload)
        self.assertEqual(cleaned["patientName"], "[redacted]")
        self.assertEqual(cleaned["patient_name"], "[redacted]")
        self.assertEqual(cleaned["firstName"], "[redacted]")
        self.assertEqual(cleaned["lastName"], "[redacted]")
        self.assertEqual(cleaned["phone"], "[redacted]")
        self.assertEqual(cleaned["email"], "[redacted]")
        self.assertEqual(cleaned["caseId"], "[redacted]")
        self.assertEqual(cleaned["uhid"], "[redacted]")
        self.assertEqual(cleaned["doctorName"], "[redacted]")

    def test_redacts_raw_ocr_and_text(self):
        payload = {
            "rawText": "Long OCR text line from laboratory instrument scan...",
            "raw_text": "Random blood sugar test...",
            "extractedText": "Hemoglobin 11.2...",
        }
        cleaned = redact_sensitive_data(payload)
        self.assertEqual(cleaned["rawText"], "[redacted]")
        self.assertEqual(cleaned["raw_text"], "[redacted]")
        self.assertEqual(cleaned["extractedText"], "[redacted]")

    def test_preserves_non_sensitive_metadata(self):
        payload = {
            "document_id": "doc_999",
            "page_count": 2,
            "status": "completed",
            "nested": {
                "safe_key": "safe_val",
                "patient_name": "Secret",
            },
        }
        cleaned = redact_sensitive_data(payload)
        self.assertEqual(cleaned["document_id"], "doc_999")
        self.assertEqual(cleaned["page_count"], 2)
        self.assertEqual(cleaned["status"], "completed")
        self.assertEqual(cleaned["nested"]["safe_key"], "safe_val")
        self.assertEqual(cleaned["nested"]["patient_name"], "[redacted]")

    def test_logged_snippet_and_patient_name_redacted_through_real_logger(self):
        import io
        import logging
        from app.core.logging import configure_logging

        log_stream = io.StringIO()
        handler = logging.StreamHandler(log_stream)
        handler.setFormatter(logging.Formatter("%(levelname)s %(name)s %(message)s patient=%(patient_name)s raw=%(raw_text)s"))

        # Configure and install safe makeRecord hook
        configure_logging("INFO")
        logger = logging.getLogger("test_redaction_logger")
        logger.addHandler(handler)
        logger.setLevel(logging.INFO)

        try:
            logger.info(
                "Document stage processed",
                extra={
                    "patient_name": "Jane Doe",
                    "raw_text": "Hemoglobin (Hb) 11.20 gm% Normal Range 12-15",
                },
            )
            output = log_stream.getvalue()

            self.assertIn("[redacted]", output)
            self.assertNotIn("Jane Doe", output)
            self.assertNotIn("Hemoglobin (Hb) 11.20", output)
        finally:
            logger.removeHandler(handler)


if __name__ == "__main__":
    unittest.main()
