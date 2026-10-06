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


if __name__ == "__main__":
    unittest.main()
