const { buildUnifiedResponse } = require("../../src/helpers/unifiedChat.helper");
const {
  buildStructuredReportPayload,
  formatReportSummaryPayload,
} = require("../../src/helpers/reportPayload.helper");
const { chatService } = require("../../src/services/ai/chat/chat.service");

describe("REPORT_SUMMARY Action & ASK_ABOUT_REPORT Tests", () => {
  test("buildUnifiedResponse includes actions array and reportSummary payload when provided", () => {
    const mockReportSummary = {
      report_id: "doc_123",
      report_name: "Blood_Test.pdf",
      documentType: "LAB_REPORT",
      report_date: "2026-10-01",
      hospitalName: "City Hospital",
      doctorName: "Dr. Smith",
      summary: "CBC shows normal parameters.",
      key_findings: "CBC shows normal parameters.",
      abnormal_values: [],
      extracted_medicines: [{ name: "Paracetamol", dosage: "500mg" }],
    };

    const response = buildUnifiedResponse({
      mode: "ACTION",
      actionType: "CONFIRM_MEDICINES",
      reply: "1 medications have been successfully added.",
      sessionId: "session_abc",
      medicines: [{ id: "med_1", medicationName: "Paracetamol" }],
      actions: [
        {
          actionType: "REPORT_SUMMARY",
          reportSummary: mockReportSummary,
        },
      ],
      reportSummary: mockReportSummary,
    });

    expect(response.actionType).toBe("CONFIRM_MEDICINES");
    expect(response.reply).toBe("1 medications have been successfully added.");
    expect(response.actions).toBeDefined();
    expect(Array.isArray(response.actions)).toBe(true);
    expect(response.actions.length).toBe(1);
    expect(response.actions[0].actionType).toBe("REPORT_SUMMARY");
    expect(response.actions[0].reportSummary.report_id).toBe("doc_123");
    expect(response.reportSummary).toEqual(mockReportSummary);
  });

  test("buildStructuredReportPayload handles missing activeDoc safely by returning NO_REPORT_FOUND action payload", async () => {
    const payload = await buildStructuredReportPayload({
      docRecord: null,
      targetDocId: "non_existent_doc_id",
      userId: null,
      preferredLanguage: "english",
    });

    expect(payload.action).toBe("ASK_REPORT");
    expect(payload.document).toBeNull();
    expect(payload.error).toBe("NO_REPORT_FOUND");
  });

  test("buildStructuredReportPayload correctly parses extractedStructuredData and reportType PRESCRIPTION", async () => {
    const mockOcrDoc = {
      id: "doc_test_prescription",
      fileName: "prescription.jpg",
      documentType: "medical_document",
      extractedStructuredData: {
        reportType: "PRESCRIPTION",
        summary: "Prescription for Tab. MBSON SL and Tab. Caldison D3.",
        patientInfo: {
          name: "URMILA HIPARPA",
          age: 45,
          gender: "female",
        },
      },
    };

    const payload = await buildStructuredReportPayload({
      docRecord: mockOcrDoc,
      preferredLanguage: "english",
    });

    expect(payload.document).toBeDefined();
    expect(payload.document.documentType).toBe("PRESCRIPTION");
    expect(payload.document.isPrescription).toBe(true);
    expect(payload.document.summary).toBe("Prescription for Tab. MBSON SL and Tab. Caldison D3.");
  });

  test("formatReportSummaryPayload correctly formats report document structure", () => {
    const mockReportData = {
      document: {
        id: "doc_999",
        fileName: "Lab_Report.pdf",
        documentType: "LAB_REPORT",
        reportDate: "2026-10-05",
        hospitalName: "Metro Clinic",
        doctorName: "Dr. Mehta",
        summary: "Blood glucose is slightly elevated.",
        keyFindings: "Blood glucose: 140 mg/dL",
        patientDetails: { name: "Patient", age: 45 },
        isLabReport: true,
        isPrescription: false,
        isOtherMedicalDoc: false,
        abnormalResults: [{ name: "Glucose", value: "140", isAbnormal: true }],
        normalResults: [],
        medicationFindings: [],
      },
    };

    const formatted = formatReportSummaryPayload(mockReportData);
    expect(formatted.report_id).toBe("doc_999");
    expect(formatted.report_name).toBe("Lab_Report.pdf");
    expect(formatted.documentType).toBe("LAB_REPORT");
    expect(formatted.hospitalName).toBe("Metro Clinic");
    expect(formatted.abnormal_values.length).toBe(1);
    expect(formatted.abnormal_values[0].name).toBe("Glucose");
  });

  test("chatService.sendMessage handles ASK_ABOUT_REPORT fallback when no report exists", async () => {
    const response = await chatService.sendMessage({
      userId: "non_existent_user_id_12345",
      question: "ASK_ABOUT_REPORT",
      preferredLanguage: "english",
    });

    expect(response).toBeDefined();
    expect(response.reply).toBe("No active medical reports found in your profile.");
    expect(response.error).toBe("NO_REPORT_FOUND");
  });
});
