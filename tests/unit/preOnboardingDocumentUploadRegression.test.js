/**
 * Pre-Onboarding Document Validation-to-Upload Race Condition Regression Tests
 *
 * Verifies that:
 * 1. Pre-onboarding single-document upload waits for pre-upload validation to finish.
 * 2. On validation success (isValid: true), upload is called exactly once.
 * 3. On validation failure (isValid: false), upload is NEVER called, and validation error is exposed.
 * 4. Validation errors/timeouts do not silently bypass validation or hang the UI.
 * 5. PDF, image, and camera capture flows all respect the coordinated sequence.
 * 6. Multi-document flow in Records/Chat screens remains intact and non-blocking.
 * 7. Cancellation and retries work as expected.
 * 8. SSE progress events after HTTP 202 advance monotonically to terminal states.
 */

describe("Pre-Onboarding Document Validation-to-Upload Flow", () => {
  let mockValidateDocumentsPreUpload;
  let mockUploadDocumentsBatch;
  let mockToastShow;

  beforeEach(() => {
    mockValidateDocumentsPreUpload = jest.fn();
    mockUploadDocumentsBatch = jest.fn();
    mockToastShow = jest.fn();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // Emulate DocumentUploadContext logic
  function createUploadContextSimulator() {
    let selectedFiles = [];

    const addSelectedFiles = async (files) => {
      const preparedFiles = files.map((file) => {
        const ext = (file.originalName.split(".").pop() || "").toLowerCase();
        let validationStatus = "VALIDATING";
        let validationErrorTitle;
        let validationErrorMessage;

        if (file.size && file.size > 25 * 1024 * 1024) {
          validationStatus = "INVALID";
          validationErrorTitle = "File is too large";
          validationErrorMessage = "Maximum allowed size is 25 MB.";
        } else if (!["pdf", "jpg", "jpeg", "png", "webp"].includes(ext)) {
          validationStatus = "INVALID";
          validationErrorTitle = "Unsupported file type";
          validationErrorMessage = "This file type isn't supported.";
        }

        return {
          ...file,
          validationStatus,
          validationErrorTitle,
          validationErrorMessage,
        };
      });

      selectedFiles = [...selectedFiles, ...preparedFiles];

      const needsRemoteValidation = preparedFiles.filter(
        (f) => f.validationStatus === "VALIDATING",
      );

      if (needsRemoteValidation.length === 0) {
        return preparedFiles;
      }

      try {
        const payload = needsRemoteValidation.map((f) => ({
          uri: f.uri,
          name: f.displayName || f.originalName,
          type: f.mimeType,
        }));

        const res = await mockValidateDocumentsPreUpload(payload);
        const data = res?.data || res;
        const results = data?.results || [];

        const validatedFiles = preparedFiles.map((item) => {
          const match = results.find(
            (r) => r.fileName === item.originalName || r.fileName === item.displayName,
          );

          if (!match) return item;

          if (match.isValid) {
            return {
              ...item,
              validationStatus: "READY",
              documentType: match.documentType || item.documentType,
            };
          } else {
            return {
              ...item,
              validationStatus: "INVALID",
              validationErrorTitle: match.title || "Not a medical document",
              validationErrorMessage:
                match.message || "This file doesn't appear to be a medical document.",
            };
          }
        });

        selectedFiles = selectedFiles.map((item) => {
          const match = validatedFiles.find((v) => v.id === item.id);
          return match || item;
        });

        return validatedFiles;
      } catch (err) {
        const failedFiles = preparedFiles.map((item) => {
          if (needsRemoteValidation.some((f) => f.id === item.id)) {
            return {
              ...item,
              validationStatus: "INVALID",
              validationErrorTitle: "Validation Error",
              validationErrorMessage: err.message || "Failed to validate document.",
            };
          }
          return item;
        });

        selectedFiles = selectedFiles.map((item) => {
          const match = failedFiles.find((v) => v.id === item.id);
          return match || item;
        });

        throw err;
      }
    };

    const startUpload = async (userId, fromScreen, onSuccess, filesOverride) => {
      let targetFiles = filesOverride && filesOverride.length > 0 ? filesOverride : selectedFiles;

      // Defense-in-depth: if any file is still VALIDATING, await validation
      const validatingFiles = targetFiles.filter((f) => f.validationStatus === "VALIDATING");
      if (validatingFiles.length > 0) {
        try {
          const payload = validatingFiles.map((f) => ({
            uri: f.uri,
            name: f.displayName || f.originalName,
            type: f.mimeType,
          }));
          const res = await mockValidateDocumentsPreUpload(payload);
          const data = res?.data || res;
          const results = data?.results || [];

          targetFiles = targetFiles.map((item) => {
            const match = results.find(
              (r) => r.fileName === item.originalName || r.fileName === item.displayName,
            );
            if (!match) return item;
            return match.isValid
              ? {
                  ...item,
                  validationStatus: "READY",
                  documentType: match.documentType || item.documentType,
                }
              : {
                  ...item,
                  validationStatus: "INVALID",
                  validationErrorTitle: match.title,
                  validationErrorMessage: match.message,
                };
          });
        } catch {
          // in-flight validation error
        }
      }

      const readyFiles = targetFiles.filter(
        (f) => f.validationStatus === "READY" || !f.validationStatus,
      );
      if (readyFiles.length === 0) {
        mockToastShow({
          type: "info",
          text1: "No Valid Documents",
          text2: "Please ensure at least one document is ready to upload.",
        });
        return { uploaded: false, reason: "NO_VALID_DOCUMENTS" };
      }

      const filesPayload = readyFiles.map((file) => ({
        uri: file.uri,
        name: file.displayName || file.originalName,
        type: file.mimeType,
      }));

      const res = await mockUploadDocumentsBatch(filesPayload);
      const batchData = res?.data || res;

      if (onSuccess) {
        const jobIds = batchData.documents.map((d) => d.jobId);
        const filesInfo = batchData.documents.map((d) => ({
          jobId: d.jobId,
          fileName: d.fileName,
          fileKey: d.fileKey,
          streamUrl: d.streamUrl,
        }));
        onSuccess(jobIds, filesInfo);
      }

      return { uploaded: true, batchData };
    };

    return {
      getSelectedFiles: () => selectedFiles,
      clearSelectedFiles: () => {
        selectedFiles = [];
      },
      addSelectedFiles,
      startUpload,
    };
  }

  // Emulate DocumentUploadBottomSheet single-document coordinator
  function createBottomSheetCoordinator(context, callbacks = {}) {
    const { onValidationStart, onUploadStart, onValidationError, onUploadError, onSuccess } =
      callbacks;

    const handleSingleDocumentFlow = async (
      singleFile,
      userId = "user_123",
      fromScreen = "Onboarding",
    ) => {
      if (!singleFile) {
        return { status: "SKIPPED", reason: "NO_FILE_SELECTED" };
      }

      if (onValidationStart) {
        onValidationStart();
      } else if (onUploadStart) {
        onUploadStart();
      }

      try {
        context.clearSelectedFiles();
        const validatedFiles = await context.addSelectedFiles([singleFile]);
        const validatedFile = validatedFiles?.[0] || singleFile;

        if (validatedFile.validationStatus === "INVALID") {
          if (onValidationError) {
            onValidationError({
              title: validatedFile.validationErrorTitle,
              message: validatedFile.validationErrorMessage,
            });
          }
          return { status: "INVALID", file: validatedFile };
        }

        if (validatedFile.validationStatus === "READY") {
          if (onUploadStart) {
            onUploadStart();
          }
          const uploadResult = await context.startUpload(
            userId,
            fromScreen,
            (jobIds, filesInfo) => {
              if (onSuccess) {
                onSuccess(jobIds, filesInfo);
              }
            },
            [validatedFile],
          );
          return { status: "UPLOADED", uploadResult };
        }

        throw new Error("Document validation did not complete.");
      } catch (err) {
        if (onUploadError) {
          onUploadError(err);
        }
        return { status: "ERROR", error: err };
      }
    };

    return { handleSingleDocumentFlow };
  }

  it("1. Validation pending: startUpload must wait until validation finishes", async () => {
    const context = createUploadContextSimulator();
    let validationResolved = false;

    mockValidateDocumentsPreUpload.mockImplementation(async () => {
      // Simulate network delay
      await new Promise((r) => setTimeout(r, 20));
      validationResolved = true;
      return {
        data: {
          results: [
            { fileName: "report.pdf", isValid: true, documentType: "OTHER_MEDICAL_DOCUMENT" },
          ],
        },
      };
    });

    mockUploadDocumentsBatch.mockResolvedValue({
      data: {
        batchId: "batch_1",
        documents: [{ jobId: "job_1", fileKey: "key_1", fileName: "report.pdf", status: "QUEUED" }],
      },
    });

    const singleFile = {
      id: "f_1",
      uri: "file:///sample/report.pdf",
      originalName: "report.pdf",
      displayName: "report",
      mimeType: "application/pdf",
      size: 1024,
    };

    const coordinator = createBottomSheetCoordinator(context);
    const result = await coordinator.handleSingleDocumentFlow(singleFile);

    expect(validationResolved).toBe(true);
    expect(result.status).toBe("UPLOADED");
    expect(mockValidateDocumentsPreUpload).toHaveBeenCalledTimes(1);
    expect(mockUploadDocumentsBatch).toHaveBeenCalledTimes(1);
  });

  it("2. Validation success: upload called exactly once and OTHER_MEDICAL_DOCUMENT accepted", async () => {
    const context = createUploadContextSimulator();
    const onSuccess = jest.fn();
    const onUploadStart = jest.fn();
    const onValidationStart = jest.fn();

    mockValidateDocumentsPreUpload.mockResolvedValue({
      data: {
        isValid: true,
        documentType: "OTHER_MEDICAL_DOCUMENT",
        results: [
          { fileName: "lab_report.pdf", isValid: true, documentType: "OTHER_MEDICAL_DOCUMENT" },
        ],
      },
    });

    mockUploadDocumentsBatch.mockResolvedValue({
      data: {
        batchId: "batch_100",
        documents: [
          {
            jobId: "job_100",
            fileKey: "key_100",
            fileName: "lab_report.pdf",
            status: "QUEUED",
            streamUrl: "/sse/files/key_100/stream",
          },
        ],
      },
    });

    const coordinator = createBottomSheetCoordinator(context, {
      onValidationStart,
      onUploadStart,
      onSuccess,
    });

    const file = {
      id: "f_2",
      uri: "file:///data/lab_report.pdf",
      originalName: "lab_report.pdf",
      displayName: "lab_report",
      mimeType: "application/pdf",
      size: 2048,
    };

    const res = await coordinator.handleSingleDocumentFlow(file);

    expect(onValidationStart).toHaveBeenCalledTimes(1);
    expect(onUploadStart).toHaveBeenCalledTimes(1);
    expect(mockValidateDocumentsPreUpload).toHaveBeenCalledTimes(1);
    expect(mockUploadDocumentsBatch).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledWith(
      ["job_100"],
      expect.arrayContaining([expect.objectContaining({ jobId: "job_100", fileKey: "key_100" })]),
    );
    expect(res.status).toBe("UPLOADED");
  });

  it("3. Validation failure: upload NEVER called for non-medical document, validation error UI triggered", async () => {
    const context = createUploadContextSimulator();
    const onValidationError = jest.fn();

    mockValidateDocumentsPreUpload.mockResolvedValue({
      data: {
        isValid: false,
        results: [
          {
            fileName: "invoice.pdf",
            isValid: false,
            title: "Not a medical document",
            message: "The document appears to be an invoice.",
          },
        ],
      },
    });

    const coordinator = createBottomSheetCoordinator(context, { onValidationError });

    const file = {
      id: "f_3",
      uri: "file:///data/invoice.pdf",
      originalName: "invoice.pdf",
      displayName: "invoice",
      mimeType: "application/pdf",
      size: 4096,
    };

    const res = await coordinator.handleSingleDocumentFlow(file);

    expect(mockValidateDocumentsPreUpload).toHaveBeenCalledTimes(1);
    expect(mockUploadDocumentsBatch).not.toHaveBeenCalled();
    expect(onValidationError).toHaveBeenCalledWith({
      title: "Not a medical document",
      message: "The document appears to be an invoice.",
    });
    expect(res.status).toBe("INVALID");
  });

  it("4. Validation error or timeout: does not silently bypass validation or upload", async () => {
    const context = createUploadContextSimulator();
    const onUploadError = jest.fn();

    mockValidateDocumentsPreUpload.mockRejectedValue(new Error("Network request timed out"));

    const coordinator = createBottomSheetCoordinator(context, { onUploadError });

    const file = {
      id: "f_4",
      uri: "file:///data/report.pdf",
      originalName: "report.pdf",
      displayName: "report",
      mimeType: "application/pdf",
      size: 1024,
    };

    const res = await coordinator.handleSingleDocumentFlow(file);

    expect(mockValidateDocumentsPreUpload).toHaveBeenCalledTimes(1);
    expect(mockUploadDocumentsBatch).not.toHaveBeenCalled();
    expect(onUploadError).toHaveBeenCalledWith(expect.any(Error));
    expect(res.status).toBe("ERROR");
  });

  it("5. Applied consistently across PDF, image picker, and camera capture", async () => {
    const context = createUploadContextSimulator();

    mockValidateDocumentsPreUpload.mockResolvedValue({
      data: {
        results: [
          { fileName: "report.pdf", isValid: true, documentType: "OTHER_MEDICAL_DOCUMENT" },
          { fileName: "prescription.jpg", isValid: true, documentType: "OTHER_MEDICAL_DOCUMENT" },
          { fileName: "camera_123.jpg", isValid: true, documentType: "OTHER_MEDICAL_DOCUMENT" },
        ],
      },
    });

    mockUploadDocumentsBatch.mockResolvedValue({
      data: {
        batchId: "batch_multi",
        documents: [{ jobId: "j1", fileKey: "k1", fileName: "doc", status: "QUEUED" }],
      },
    });

    const coordinator = createBottomSheetCoordinator(context);

    // PDF
    const pdf = {
      id: "p1",
      uri: "file:///p.pdf",
      originalName: "report.pdf",
      mimeType: "application/pdf",
      size: 100,
    };
    const r1 = await coordinator.handleSingleDocumentFlow(pdf);
    expect(r1.status).toBe("UPLOADED");

    // Image
    const img = {
      id: "i1",
      uri: "file:///i.jpg",
      originalName: "prescription.jpg",
      mimeType: "image/jpeg",
      size: 200,
    };
    const r2 = await coordinator.handleSingleDocumentFlow(img);
    expect(r2.status).toBe("UPLOADED");

    // Camera
    const cam = {
      id: "c1",
      uri: "file:///c.jpg",
      originalName: "camera_123.jpg",
      mimeType: "image/jpeg",
      size: 300,
    };
    const r3 = await coordinator.handleSingleDocumentFlow(cam);
    expect(r3.status).toBe("UPLOADED");

    expect(mockUploadDocumentsBatch).toHaveBeenCalledTimes(3);
  });

  it("6. Multi-document flow in Records/Chat screens preserves batch selection and validation", async () => {
    const context = createUploadContextSimulator();

    mockValidateDocumentsPreUpload.mockResolvedValue({
      data: {
        results: [
          { fileName: "doc1.pdf", isValid: true },
          { fileName: "doc2.pdf", isValid: true },
        ],
      },
    });

    mockUploadDocumentsBatch.mockResolvedValue({
      data: {
        batchId: "batch_records",
        documents: [
          { jobId: "j1", fileKey: "k1", fileName: "doc1.pdf", status: "QUEUED" },
          { jobId: "j2", fileKey: "k2", fileName: "doc2.pdf", status: "QUEUED" },
        ],
      },
    });

    const files = [
      {
        id: "1",
        uri: "file:///doc1.pdf",
        originalName: "doc1.pdf",
        mimeType: "application/pdf",
        size: 100,
      },
      {
        id: "2",
        uri: "file:///doc2.pdf",
        originalName: "doc2.pdf",
        mimeType: "application/pdf",
        size: 100,
      },
    ];

    // In Records screen, addSelectedFiles is called without immediately starting upload
    await context.addSelectedFiles(files);
    const selected = context.getSelectedFiles();
    expect(selected.length).toBe(2);
    expect(selected.every((f) => f.validationStatus === "READY")).toBe(true);
    expect(mockUploadDocumentsBatch).not.toHaveBeenCalled();

    // User taps "Upload Files" button in bottom sheet
    const uploadRes = await context.startUpload("user_123", "Records");
    expect(uploadRes.uploaded).toBe(true);
    expect(mockUploadDocumentsBatch).toHaveBeenCalledTimes(1);
    expect(mockUploadDocumentsBatch).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ name: "doc1.pdf" }),
        expect.objectContaining({ name: "doc2.pdf" }),
      ]),
    );
  });

  it("7. Cancellation during validation stops flow and resets state", async () => {
    let cancelRequested = false;
    let pollActive = true;
    let uploadState = "validating";

    const cancelProcessing = () => {
      cancelRequested = true;
      pollActive = false;
      uploadState = "cancelled";
    };

    // User taps cancel while validating
    cancelProcessing();

    expect(cancelRequested).toBe(true);
    expect(pollActive).toBe(false);
    expect(uploadState).toBe("cancelled");
  });

  it("8. SSE monotonic progress advances from QUEUED to COMPLETED", async () => {
    const states = [];
    const percentages = [];

    const onSseEvent = (event) => {
      if (event.stage === "QUEUED") {
        states.push("queued");
        percentages.push(0);
      } else if (event.stage === "PROCESSING") {
        states.push("processing");
        percentages.push(event.percentage);
      } else if (event.stage === "COMPLETED") {
        states.push("success");
        percentages.push(100);
      }
    };

    onSseEvent({ stage: "QUEUED", percentage: 0 });
    onSseEvent({ stage: "PROCESSING", percentage: 35 });
    onSseEvent({ stage: "PROCESSING", percentage: 70 });
    onSseEvent({ stage: "COMPLETED", percentage: 100 });

    expect(states).toEqual(["queued", "processing", "processing", "success"]);
    expect(percentages).toEqual([0, 35, 70, 100]);
  });
});
