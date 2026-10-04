const { buildUnifiedResponse } = require("../../src/helpers/unifiedChat.helper");
const { buildStructuredReportPayload } = require("../../src/helpers/reportPayload.helper");

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
});
