const sharp = require("sharp");
const { preprocessImage, cleanOcrText } = require("../../src/helpers/ocrNormalizer.helper");
const prompts = require("../../src/services/ai/prompts");

describe("Phase 4: Preprocessing, Layout Analysis & Ad-Region Filtering Unit Tests", () => {
  describe("1. Image Preprocessing (Sharp)", () => {
    test("Preprocesses valid image: normalizes, sharpens, resizes to max 1600px, and converts to JPEG", async () => {
      // Create a test 2000x1200 raw image
      const inputBuffer = await sharp({
        create: {
          width: 2000,
          height: 1200,
          channels: 3,
          background: { r: 240, g: 240, b: 240 },
        },
      })
        .png()
        .toBuffer();

      const processedBuffer = await preprocessImage(inputBuffer);
      expect(processedBuffer).toBeInstanceOf(Buffer);
      expect(processedBuffer.length).toBeGreaterThan(0);

      const metadata = await sharp(processedBuffer).metadata();
      expect(metadata.format).toBe("jpeg");
      // Fit inside 1600x1600 bounding box
      expect(metadata.width).toBeLessThanOrEqual(1600);
      expect(metadata.height).toBeLessThanOrEqual(1600);
      expect(metadata.width).toBe(1600);
      expect(metadata.height).toBe(960);
    });

    test("Preprocesses small image without enlarging", async () => {
      const inputBuffer = await sharp({
        create: {
          width: 400,
          height: 300,
          channels: 3,
          background: { r: 100, g: 150, b: 200 },
        },
      })
        .png()
        .toBuffer();

      const processedBuffer = await preprocessImage(inputBuffer);
      const metadata = await sharp(processedBuffer).metadata();
      expect(metadata.format).toBe("jpeg");
      expect(metadata.width).toBe(400);
      expect(metadata.height).toBe(300);
    });

    test("Falls back gracefully to raw buffer when input is invalid or corrupted", async () => {
      const corruptBuffer = Buffer.from("not_an_image_corrupt_data");
      const fallbackResult = await preprocessImage(corruptBuffer);
      expect(fallbackResult).toBe(corruptBuffer);
    });
  });

  describe("2. Non-Clinical Advertising & Marketing Slogan Filtering", () => {
    test("Filters out app download promotions and mobile ads", () => {
      const rawText = [
        "Patient Name: John Doe",
        "Download our mobile app for faster lab reports",
        "Prescribed: Tab. Paracetamol 500mg 1-0-1",
        "Download app from Google Play Store",
      ].join("\n");

      const cleaned = cleanOcrText(rawText);
      expect(cleaned).toContain("Patient Name: John Doe");
      expect(cleaned).toContain("Prescribed: Tab. Paracetamol 500mg 1-0-1");
      expect(cleaned).not.toContain("Download our mobile app");
      expect(cleaned).not.toContain("Download app");
    });

    test("Filters out promotional discount offers, coupons, and promo codes", () => {
      const rawText = [
        "Hospital: Apollo Clinic",
        "Get flat 20% discount on executive full body checkups",
        "Use coupon code HEALTH50 for free consultation",
        "Diagnosis: Acute Pharyngitis",
        "Promo code WELCOME10 for pharmacy discounts",
      ].join("\n");

      const cleaned = cleanOcrText(rawText);
      expect(cleaned).toContain("Hospital: Apollo Clinic");
      expect(cleaned).toContain("Diagnosis: Acute Pharyngitis");
      expect(cleaned).not.toContain("20% discount");
      expect(cleaned).not.toContain("coupon code HEALTH50");
      expect(cleaned).not.toContain("Promo code WELCOME10");
    });

    test("Filters out toll-free helplines, marketing websites, and social media links", () => {
      const rawText = [
        "Dr. Sharma's Clinic",
        "Contact Toll-Free 1800-200-5555 for booking appointments",
        "Visit our website www.sharmaclinic.org",
        "Follow us on Instagram and Facebook @sharma_clinic",
        "Vitals: BP 120/80 mmHg, Pulse 72 bpm",
      ].join("\n");

      const cleaned = cleanOcrText(rawText);
      expect(cleaned).toContain("Dr. Sharma's Clinic");
      expect(cleaned).toContain("Vitals: BP 120/80 mmHg, Pulse 72 bpm");
      expect(cleaned).not.toContain("1800-200-5555");
      expect(cleaned).not.toContain("Visit our website");
      expect(cleaned).not.toContain("Follow us on");
    });

    test("Filters out institutional marketing slogans and patient vanity metrics", () => {
      const rawText = [
        "City Multi-speciality Hospital",
        "Serving humanity since 1975",
        "Trusted by 10M+ patients across western India",
        "NABH accredited multi-speciality hospital",
        "Tab. Metformin 500mg - 1 Tab twice daily",
      ].join("\n");

      const cleaned = cleanOcrText(rawText);
      expect(cleaned).toContain("City Multi-speciality Hospital");
      expect(cleaned).toContain("Tab. Metformin 500mg - 1 Tab twice daily");
      expect(cleaned).not.toContain("Serving humanity since 1975");
      expect(cleaned).not.toContain("Trusted by 10M+ patients");
      expect(cleaned).not.toContain("NABH accredited");
    });
  });

  describe("3. Legal Disclaimer and Non-Clinical Boilerplate Filtering", () => {
    test("Removes standard lab report electronic signature and medico-legal disclaimers", () => {
      const rawText = [
        "Blood Test Result: Fasting Blood Sugar - 110 mg/dL",
        "This report is electronically generated and requires no physical signature",
        "Not valid for medico-legal purposes",
        "Results relate only to the specimen received",
        "Kindly correlate clinically with clinical findings",
        "Subject to Ahmedabad jurisdiction only",
      ].join("\n");

      const cleaned = cleanOcrText(rawText);
      expect(cleaned).toContain("Blood Test Result: Fasting Blood Sugar - 110 mg/dL");
      expect(cleaned).not.toContain("electronically generated");
      expect(cleaned).not.toContain("medico-legal");
      expect(cleaned).not.toContain("specimen received");
      expect(cleaned).not.toContain("correlate clinically");
      expect(cleaned).not.toContain("jurisdiction");
    });

    test("Preserves legitimate doctor instructions, remarks, and clinical notes", () => {
      const rawText = [
        "Doctor's Advice:",
        "Patient advised to reduce salt intake and walk 30 mins daily",
        "Correlate blood sugar monitoring with dietary log",
        "Review SOS if symptoms worsen or fever exceeds 101 F",
      ].join("\n");

      const cleaned = cleanOcrText(rawText);
      expect(cleaned).toContain("Doctor's Advice:");
      expect(cleaned).toContain("Patient advised to reduce salt intake and walk 30 mins daily");
      expect(cleaned).toContain("Correlate blood sugar monitoring with dietary log");
      expect(cleaned).toContain("Review SOS if symptoms worsen or fever exceeds 101 F");
    });
  });

  describe("4. Semantic Diagram Tagging & Visual Noise Rejection", () => {
    test("Preserves semantic diagram, chart, and figure descriptor tags", () => {
      const rawText = [
        "Clinical Examination Note:",
        "[DIAGRAM: 12-lead ECG rhythm strip showing normal sinus rhythm without ST elevation]",
        "Heart Rate: 74 bpm",
        "[FIGURE: Chest X-ray PA view showing clear costophrenic angles]",
        "[CHART: Dental quadrant notation showing caries in tooth #18]",
        "Prescription: Cap. Amoxicillin 500mg TDS x 5 days",
      ].join("\n");

      const cleaned = cleanOcrText(rawText);
      expect(cleaned).toContain(
        "[DIAGRAM: 12-lead ECG rhythm strip showing normal sinus rhythm without ST elevation]",
      );
      expect(cleaned).toContain("[FIGURE: Chest X-ray PA view showing clear costophrenic angles]");
      expect(cleaned).toContain("[CHART: Dental quadrant notation showing caries in tooth #18]");
      expect(cleaned).toContain("Prescription: Cap. Amoxicillin 500mg TDS x 5 days");
    });

    test("Strips repetitive visual ASCII noise (borders, dividers, scan lines)", () => {
      const rawText = [
        "Patient: Anita Sharma",
        "----------------------------------------",
        "||||||||||||||||||||||||||||||||||||||||",
        "~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~",
        "========================================",
        "Hemoglobin: 13.2 g/dL (Normal: 12.0 - 15.0)",
        "........................................",
      ].join("\n");

      const cleaned = cleanOcrText(rawText);
      expect(cleaned).toContain("Patient: Anita Sharma");
      expect(cleaned).toContain("Hemoglobin: 13.2 g/dL (Normal: 12.0 - 15.0)");
      expect(cleaned).not.toContain("----------------------------------------");
      expect(cleaned).not.toContain("||||||||||||||||||||||||||||||||||||||||");
      expect(cleaned).not.toContain("~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~");
      expect(cleaned).not.toContain("========================================");
    });

    test("Strips LLM reasoning tags and internal thought intros", () => {
      const rawText = [
        "<think>",
        "Looking at the prescription image...",
        "The patient name seems to be Rajesh.",
        "</think>",
        "Patient Name: Rajesh Patel",
        "Wait, let me verify the dosage",
        "Rx: Tab. Telmisartan 40mg 1-0-0",
      ].join("\n");

      const cleaned = cleanOcrText(rawText);
      expect(cleaned).toContain("Patient Name: Rajesh Patel");
      expect(cleaned).toContain("Rx: Tab. Telmisartan 40mg 1-0-0");
      expect(cleaned).not.toContain("<think>");
      expect(cleaned).not.toContain("Looking at the prescription image");
      expect(cleaned).not.toContain("Wait, let me verify the dosage");
    });
  });

  describe("5. OCR Prompt Verification (PAGE_CLASSIFY_OCR_PROMPT)", () => {
    test("Prompt requires strict four-category classification", () => {
      expect(prompts.PAGE_CLASSIFY_OCR_PROMPT).toContain('"MEDICAL"');
      expect(prompts.PAGE_CLASSIFY_OCR_PROMPT).toContain('"ADVERTISEMENT"');
      expect(prompts.PAGE_CLASSIFY_OCR_PROMPT).toContain('"COVER"');
      expect(prompts.PAGE_CLASSIFY_OCR_PROMPT).toContain('"OTHER"');
    });

    test("Prompt mandates excluding commercial ads, marketing, and legal disclaimers", () => {
      expect(prompts.PAGE_CLASSIFY_OCR_PROMPT).toContain("EXCLUDE NON-CLINICAL REGIONS");
      expect(prompts.PAGE_CLASSIFY_OCR_PROMPT).toContain("Exclude commercial advertisements");
      expect(prompts.PAGE_CLASSIFY_OCR_PROMPT).toContain("Exclude legal boilerplate disclaimers");
    });

    test("Prompt mandates semantic diagram tagging instead of ASCII noise", () => {
      expect(prompts.PAGE_CLASSIFY_OCR_PROMPT).toContain("SEMANTIC DIAGRAM & FIGURE TAGGING");
      expect(prompts.PAGE_CLASSIFY_OCR_PROMPT).toContain(
        "[DIAGRAM: <type> - <brief clinical description>]",
      );
      expect(prompts.PAGE_CLASSIFY_OCR_PROMPT).toContain(
        "DO NOT transcribe visual lines as ASCII symbols",
      );
    });
  });
});
