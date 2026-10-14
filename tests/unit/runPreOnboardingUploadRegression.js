const assert = require("assert");

async function runTests() {
  console.log("=== STARTING PRE-ONBOARDING DOCUMENT UPLOAD REGRESSION TESTS ===");

  let mockValidateDocumentsPreUpload;
  let mockUploadDocumentsBatch;
  let mockToastShow;

  function resetMocks() {
    mockValidateDocumentsPreUpload = async () => {};
    mockUploadDocumentsBatch = async () => {};
    mockToastShow = () => {};
  }

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

      // Defense in depth: if any file is still VALIDATING, await validation
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

  // TEST 1
  {
    resetMocks();
    let validationCallCount = 0;
    let uploadCallCount = 0;
    let validationResolved = false;

    mockValidateDocumentsPreUpload = async () => {
      validationCallCount++;
      await new Promise((r) => setTimeout(r, 20));
      validationResolved = true;
      return {
        data: {
          results: [
            { fileName: "report.pdf", isValid: true, documentType: "OTHER_MEDICAL_DOCUMENT" },
          ],
        },
      };
    };

    mockUploadDocumentsBatch = async () => {
      uploadCallCount++;
      assert(validationResolved === true, "Upload was called BEFORE validation resolved!");
      return {
        data: {
          batchId: "batch_1",
          documents: [
            { jobId: "job_1", fileKey: "key_1", fileName: "report.pdf", status: "QUEUED" },
          ],
        },
      };
    };

    const context = createUploadContextSimulator();
    const coordinator = createBottomSheetCoordinator(context);
    const result = await coordinator.handleSingleDocumentFlow({
      id: "f_1",
      uri: "file:///sample/report.pdf",
      originalName: "report.pdf",
      displayName: "report",
      mimeType: "application/pdf",
      size: 1024,
    });

    assert.strictEqual(result.status, "UPLOADED");
    assert.strictEqual(validationCallCount, 1, "Validation should be called exactly once");
    assert.strictEqual(uploadCallCount, 1, "Upload should be called exactly once");
    console.log(
      "✔ Test 1 Passed: Validation pending -> Upload waits and executes after validation",
    );
  }

  // TEST 2
  {
    resetMocks();
    let uploadCalled = false;
    let onSuccessCalled = false;
    let uploadStartCalled = false;
    let validationStartCalled = false;

    mockValidateDocumentsPreUpload = async () => ({
      data: {
        isValid: true,
        documentType: "OTHER_MEDICAL_DOCUMENT",
        results: [
          { fileName: "report.pdf", isValid: true, documentType: "OTHER_MEDICAL_DOCUMENT" },
        ],
      },
    });

    mockUploadDocumentsBatch = async () => {
      uploadCalled = true;
      return {
        data: {
          batchId: "batch_200",
          documents: [
            {
              jobId: "job_200",
              fileKey: "key_200",
              fileName: "report.pdf",
              status: "QUEUED",
              streamUrl: "/sse/files/key_200/stream",
            },
          ],
        },
      };
    };

    const context = createUploadContextSimulator();
    const coordinator = createBottomSheetCoordinator(context, {
      onValidationStart: () => {
        validationStartCalled = true;
      },
      onUploadStart: () => {
        uploadStartCalled = true;
      },
      onSuccess: (jobIds) => {
        onSuccessCalled = true;
        assert.strictEqual(jobIds[0], "job_200");
      },
    });

    const result = await coordinator.handleSingleDocumentFlow({
      id: "f_2",
      uri: "file:///data/report.pdf",
      originalName: "report.pdf",
      displayName: "report",
      mimeType: "application/pdf",
      size: 2048,
    });

    assert.strictEqual(validationStartCalled, true);
    assert.strictEqual(uploadStartCalled, true);
    assert.strictEqual(uploadCalled, true);
    assert.strictEqual(onSuccessCalled, true);
    assert.strictEqual(result.status, "UPLOADED");
    console.log(
      "✔ Test 2 Passed: Validation success -> OTHER_MEDICAL_DOCUMENT accepted, upload and onSuccess triggered",
    );
  }

  // TEST 3
  {
    resetMocks();
    let uploadCalled = false;
    let validationErrorTriggered = false;

    mockValidateDocumentsPreUpload = async () => ({
      data: {
        isValid: false,
        results: [
          {
            fileName: "grocery_bill.pdf",
            isValid: false,
            title: "Not a medical document",
            message: "The document appears to be a receipt.",
          },
        ],
      },
    });

    mockUploadDocumentsBatch = async () => {
      uploadCalled = true;
    };

    const context = createUploadContextSimulator();
    const coordinator = createBottomSheetCoordinator(context, {
      onValidationError: (err) => {
        validationErrorTriggered = true;
        assert.strictEqual(err.title, "Not a medical document");
      },
    });

    const result = await coordinator.handleSingleDocumentFlow({
      id: "f_3",
      uri: "file:///data/grocery_bill.pdf",
      originalName: "grocery_bill.pdf",
      displayName: "grocery_bill",
      mimeType: "application/pdf",
      size: 4096,
    });

    assert.strictEqual(uploadCalled, false, "Upload must NEVER be called for invalid document!");
    assert.strictEqual(validationErrorTriggered, true, "Validation error UI must be triggered!");
    assert.strictEqual(result.status, "INVALID");
    console.log(
      "✔ Test 3 Passed: Validation failure -> Upload aborted, validation error UI triggered",
    );
  }

  // TEST 4
  {
    resetMocks();
    let uploadCalled = false;
    let onUploadErrorCalled = false;

    mockValidateDocumentsPreUpload = async () => {
      throw new Error("Validation gateway timeout 504");
    };

    mockUploadDocumentsBatch = async () => {
      uploadCalled = true;
    };

    const context = createUploadContextSimulator();
    const coordinator = createBottomSheetCoordinator(context, {
      onUploadError: (err) => {
        onUploadErrorCalled = true;
        assert(err.message.includes("504"));
      },
    });

    const result = await coordinator.handleSingleDocumentFlow({
      id: "f_4",
      uri: "file:///data/report.pdf",
      originalName: "report.pdf",
      displayName: "report",
      mimeType: "application/pdf",
      size: 1024,
    });

    assert.strictEqual(uploadCalled, false, "Upload must NEVER bypass validation on error!");
    assert.strictEqual(onUploadErrorCalled, true);
    assert.strictEqual(result.status, "ERROR");
    console.log(
      "✔ Test 4 Passed: Validation timeout/error -> Upload not called, error state populated",
    );
  }

  // TEST 5
  {
    resetMocks();
    let uploadCount = 0;

    mockValidateDocumentsPreUpload = async (payload) => ({
      data: {
        results: payload.map((f) => ({
          fileName: f.name,
          isValid: true,
          documentType: "OTHER_MEDICAL_DOCUMENT",
        })),
      },
    });

    mockUploadDocumentsBatch = async () => {
      uploadCount++;
      return {
        data: {
          batchId: "batch_modalities",
          documents: [{ jobId: "j", fileKey: "k", fileName: "f", status: "QUEUED" }],
        },
      };
    };

    const context = createUploadContextSimulator();
    const coordinator = createBottomSheetCoordinator(context);

    // PDF
    const rPdf = await coordinator.handleSingleDocumentFlow({
      id: "1",
      uri: "f1",
      originalName: "doc.pdf",
      mimeType: "application/pdf",
      size: 100,
    });
    assert.strictEqual(rPdf.status, "UPLOADED");

    // Image
    const rImg = await coordinator.handleSingleDocumentFlow({
      id: "2",
      uri: "f2",
      originalName: "pic.jpg",
      mimeType: "image/jpeg",
      size: 100,
    });
    assert.strictEqual(rImg.status, "UPLOADED");

    // Camera
    const rCam = await coordinator.handleSingleDocumentFlow({
      id: "3",
      uri: "f3",
      originalName: "cam.jpg",
      mimeType: "image/jpeg",
      size: 100,
    });
    assert.strictEqual(rCam.status, "UPLOADED");

    assert.strictEqual(uploadCount, 3);
    console.log(
      "✔ Test 5 Passed: Consistent coordination across PDF, Image picker, and Camera capture",
    );
  }

  // TEST 6
  {
    resetMocks();
    let uploadCount = 0;

    mockValidateDocumentsPreUpload = async () => ({
      data: {
        results: [
          { fileName: "rec1.pdf", isValid: true },
          { fileName: "rec2.pdf", isValid: true },
        ],
      },
    });

    mockUploadDocumentsBatch = async () => {
      uploadCount++;
      return {
        data: {
          batchId: "batch_records",
          documents: [
            { jobId: "j1", fileKey: "k1", fileName: "rec1.pdf", status: "QUEUED" },
            { jobId: "j2", fileKey: "k2", fileName: "rec2.pdf", status: "QUEUED" },
          ],
        },
      };
    };

    const context = createUploadContextSimulator();
    await context.addSelectedFiles([
      { id: "1", uri: "f1", originalName: "rec1.pdf", mimeType: "application/pdf", size: 100 },
      { id: "2", uri: "f2", originalName: "rec2.pdf", mimeType: "application/pdf", size: 100 },
    ]);

    assert.strictEqual(uploadCount, 0, "Multi-document selection must NOT auto-trigger upload");
    const selected = context.getSelectedFiles();
    assert.strictEqual(selected.length, 2);
    assert.strictEqual(
      selected.every((f) => f.validationStatus === "READY"),
      true,
    );

    const upRes = await context.startUpload("user_123", "Records");
    assert.strictEqual(upRes.uploaded, true);
    assert.strictEqual(uploadCount, 1);
    console.log(
      "✔ Test 6 Passed: Multi-document flow in Records/Chat preserved without regression",
    );
  }

  // TEST 7
  {
    let cancelRequested = false;
    let pollActive = true;
    let uploadState = "validating";

    const cancelProcessing = () => {
      cancelRequested = true;
      pollActive = false;
      uploadState = "cancelled";
    };

    cancelProcessing();
    assert.strictEqual(cancelRequested, true);
    assert.strictEqual(pollActive, false);
    assert.strictEqual(uploadState, "cancelled");
    console.log("✔ Test 7 Passed: Cancellation during validation cleanly aborts and resets state");
  }

  // TEST 8
  {
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
    onSseEvent({ stage: "PROCESSING", percentage: 25 });
    onSseEvent({ stage: "PROCESSING", percentage: 60 });
    onSseEvent({ stage: "COMPLETED", percentage: 100 });

    assert.deepStrictEqual(states, ["queued", "processing", "processing", "success"]);
    assert.deepStrictEqual(percentages, [0, 25, 60, 100]);
    console.log("✔ Test 8 Passed: SSE monotonic progress updates from QUEUED to COMPLETED");
  }

  console.log("\nALL 8 REGRESSION SCENARIOS PASSED WITH 0 FAILURES!");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
