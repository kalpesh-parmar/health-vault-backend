const {
  buildDependencyAwareContext,
  detectContextGraph,
  paginateArray,
} = require("../../src/services/ai/chat/ragContext.service");
const patientRepository = require("../../src/repositories/patientRepository");
const medicationRepository = require("../../src/repositories/medicationRepository");
const documentRepository = require("../../src/repositories/documentRepository");
const occurrenceRepository = require("../../src/repositories/medicationReminderOccurrenceRepository");
const notificationRepository = require("../../src/repositories/notificationRepository");

jest.mock("../../src/repositories/patientRepository");
jest.mock("../../src/repositories/medicationRepository", () => ({
  findAll: jest.fn().mockResolvedValue([]),
}));
jest.mock("../../src/repositories/refillRepository", () => ({
  findLatestRefillByMedicationId: jest.fn().mockResolvedValue(null),
}));
jest.mock("../../src/repositories/medicationReminderOccurrenceRepository", () => ({
  findTodayOccurrences: jest.fn().mockResolvedValue([]),
}));
jest.mock("../../src/repositories/documentRepository", () => ({
  getSummaryByUserId: jest.fn().mockResolvedValue([]),
}));
jest.mock("../../src/repositories/notificationRepository", () => ({
  list: jest.fn().mockResolvedValue([]),
}));

describe("ragContext.service Patient Details & Login Method Tests", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  test("detectContextGraph triggers PROFILE domain for login method, mobile/email, and patient details questions", () => {
    const questions = [
      "What is my login method?",
      "How did I log in?",
      "Did I log in with mobile or email?",
      "Show all details from patient table",
      "What is my patient code?",
      "વિકલ્પ: લોગિન રીત કઈ છે?",
      "लॉगिन का प्रकार क्या है?",
    ];

    questions.forEach((q) => {
      const domains = detectContextGraph(q);
      expect(domains.has("PROFILE")).toBe(true);
    });
  });

  test("buildDependencyAwareContext formats all patients table fields including Mobile OTP Firebase login method", async () => {
    patientRepository.findById.mockResolvedValue({
      id: "usr-123",
      patientCode: "P-98765",
      firstName: "Kalpesh",
      lastName: "Parmar",
      fullName: "Kalpesh Parmar",
      userName: "kalpesh_p",
      email: "kalpesh@example.com",
      countryCode: "+91",
      mobile: "9876543210",
      firebaseUid: "fb-uid-123456",
      gender: "male",
      dateOfBirth: new Date("1995-05-15"),
      bloodGroup: "O+",
      allergies: ["Penicillin", "Dust"],
      status: "ACTIVE",
      isMobileVerified: true,
      isEmailVerified: true,
      onboardingCompleted: true,
      preferredLanguage: "english",
      createdAt: new Date("2025-01-01"),
      lastLoginAt: new Date("2026-09-18T10:00:00Z"),
    });

    const context = await buildDependencyAwareContext(
      "usr-123",
      "What are my profile details and how did I log in?",
    );

    expect(context).toContain("P-98765");
    expect(context).toContain("Kalpesh Parmar");
    expect(context).toContain("kalpesh@example.com");
    expect(context).toContain("+919876543210");
    expect(context).toContain("fb-uid-123456");
    expect(context).toContain("Mobile OTP via Firebase Auth");
    expect(context).toContain("Penicillin, Dust");
    expect(context).toContain("Account Status: ACTIVE");
    expect(context).toContain("Mobile Verified: Yes");
    expect(context).toContain("Email Verified: Yes");
  });

  test("buildDependencyAwareContext formats Email & Password login method when firebaseUid and phone are absent", async () => {
    patientRepository.findById.mockResolvedValue({
      id: "usr-456",
      patientCode: "P-11223",
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@example.com",
      gender: "female",
      dateOfBirth: "1990-10-20",
      isEmailVerified: true,
      status: "ACTIVE",
    });

    const context = await buildDependencyAwareContext("usr-456", "What is my login type?");

    expect(context).toContain("Email & Password Authentication (Email: jane@example.com)");
  });

  describe("Paginated Array Data Tests for List Queries (Medications, Documents, Reminders, Notifications, Refills)", () => {
    test("paginateArray returns structured data array and page metadata for 1 item and 105 items", () => {
      // Single item
      const singleRes = paginateArray([{ id: "m-1" }], { page: 1, limit: 20 });
      expect(singleRes.data).toHaveLength(1);
      expect(singleRes.page).toEqual({
        pageNumber: 1,
        pageLimit: 20,
        totalPages: 1,
        totalRecords: 1,
        hasNextPage: false,
        hasPrevPage: false,
      });

      // 105 items
      const items105 = Array.from({ length: 105 }, (_, i) => ({ id: `doc-${i + 1}` }));
      const page1Res = paginateArray(items105, { page: 1, limit: 20 });
      expect(page1Res.data).toHaveLength(20);
      expect(page1Res.page).toEqual({
        pageNumber: 1,
        pageLimit: 20,
        totalPages: 6,
        totalRecords: 105,
        hasNextPage: true,
        hasPrevPage: false,
      });

      const page6Res = paginateArray(items105, { page: 6, limit: 20 });
      expect(page6Res.data).toHaveLength(5);
      expect(page6Res.page.hasNextPage).toBe(false);
      expect(page6Res.page.hasPrevPage).toBe(true);
    });

    test("buildDependencyAwareContext formats single item list into paginated array context", async () => {
      patientRepository.findById.mockResolvedValue({ id: "usr-1" });
      medicationRepository.findAll.mockResolvedValue([
        { id: "m-1", medicationName: "Paracetamol 500mg", ongoing: true },
      ]);
      documentRepository.getSummaryByUserId.mockResolvedValue([
        {
          id: "d-1",
          fileName: "Blood_Report.pdf",
          documentType: "lab_report",
          ocrStatus: "COMPLETED",
        },
      ]);
      occurrenceRepository.findTodayOccurrences.mockResolvedValue([
        { id: "o-1", medicationName: "Paracetamol", status: "PENDING", isOverdue: false },
      ]);
      notificationRepository.list.mockResolvedValue([
        { id: "n-1", title: "Medication Alert", body: "Time to take Paracetamol", isRead: false },
      ]);

      const context = await buildDependencyAwareContext(
        "usr-1",
        "Show my all details, medications, documents, reminders, notifications",
      );

      expect(context).toContain(
        "=== ACTIVE PROFILE MEDICATIONS & REFILL DETAILS (PAGINATED ARRAY) ===",
      );
      expect(context).toContain(
        "Pagination Metadata: [Page 1 of 1 | Total Records: 1 | Page Limit: 20 | Has Next Page: No]",
      );
      expect(context).toContain("Paracetamol 500mg");

      expect(context).toContain("=== MEDICAL DOCUMENTS CATALOG (PAGINATED ARRAY) ===");
      expect(context).toContain(
        "Pagination Metadata: [Page 1 of 1 | Total Uploaded Documents: 1 | Page Limit: 20 | Has Next Page: No]",
      );
      expect(context).toContain("Blood_Report.pdf");

      expect(context).toContain("=== MEDICATION REMINDERS STATUS TODAY (PAGINATED ARRAY) ===");
      expect(context).toContain("Total Scheduled Today: 1");

      expect(context).toContain("=== NOTIFICATIONS SUMMARY (PAGINATED ARRAY) ===");
      expect(context).toContain("Total Notifications: 1");
    });

    test("buildDependencyAwareContext formats 100+ items with pagination metadata without context overflow", async () => {
      patientRepository.findById.mockResolvedValue({ id: "usr-100" });

      const meds120 = Array.from({ length: 120 }, (_, i) => ({
        id: `med-${i + 1}`,
        medicationName: `Medicine ${i + 1}`,
        ongoing: true,
      }));
      medicationRepository.findAll.mockResolvedValue(meds120);

      const docs110 = Array.from({ length: 110 }, (_, i) => ({
        id: `doc-${i + 1}`,
        fileName: `Report_${i + 1}.pdf`,
        documentType: "lab_report",
        ocrStatus: "COMPLETED",
      }));
      documentRepository.getSummaryByUserId.mockResolvedValue(docs110);

      const context = await buildDependencyAwareContext(
        "usr-100",
        "List all medications and documents",
        { page: 1, limit: 20 },
      );

      expect(context).toContain("Total Records: 120");
      expect(context).toContain("Page 1 of 6");
      expect(context).toContain("Total Uploaded Documents: 110");
      expect(context).toContain("Page 1 of 6");
      // Page 1 should contain item 1 but not item 25
      expect(context).toContain("Medicine 1");
      expect(context).not.toContain("Medicine 25");
    });
  });
});
