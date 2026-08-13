const { z } = require("zod");
const { documentTypeValue } = require("../enums/documentType");
const fileKeySchema = z
  .object({
    fileKey: z.string().trim().min(3).max(500),
  })
  .strict();
const batchFileKeySchema = z
  .object({
    fileKeys: z.array(z.string().trim().min(3).max(500)).min(1).max(50),
  })
  .strict();
const runOcrSchema = z
  .object({
    // fileKey: z.string().trim().max(500).optional(),
    // fileKeys: z.array(z.string().trim().max(500)).optional(),
    // documentType: z.enum(documentTypeValue).optional(),
    // mimeType: z.string().trim().max(128).optional(),
    fileKey: z.preprocess(
      (val) => (!val || val === "string" ? undefined : val),
      z.string().trim().max(500).optional(),
    ),
    fileKeys: z.preprocess(
      (val) => {
        if (!val || val === "string") return undefined;
        if (typeof val === "string") {
          try {
            const parsed = JSON.parse(val);
            if (Array.isArray(parsed)) return parsed;
          } catch (e) {
            // eslint-disable-next-line no-console
            console.log(e);
          }
          return [val];
        }
        return val;
      },
      z.array(z.string().trim().max(500)).optional(),
    ),
    documentType: z.preprocess(
      (val) => (!val || val === "string" ? undefined : val),
      z.enum(documentTypeValue).optional(),
    ),
    mimeType: z.preprocess(
      (val) => (!val || val === "string" ? undefined : val),
      z.string().trim().max(128).optional(),
    ),
  })
  .strict();

const addDocumentSchema = z
  .object({
    s3Key: z.string().trim().min(3).max(500),
    documentType: z.enum(documentTypeValue).optional(),
    fileType: z.string().optional(), // Added so Zod strict() doesn't fail if passed from frontend
    fileSize: z.number().optional(),
    fileName: z.string().trim().max(255).optional(),
    s3bucket: z.string().trim().max(255).optional(),
    mimeType: z.string().trim().max(128).optional(),
    rawOcrData: z.record(z.any()).nullable().optional(),
    extractedStructuredData: z.record(z.any()).nullable().optional(),
    graphs: z.array(z.record(z.any())).optional().default([]),
    embeddingsGenerated: z.boolean().optional().default(false),
  })
  .strict();
const createChatSessionSchema = z
  .object({
    title: z.string().trim().max(255).optional(),
    documentId: z.array(z.string().uuid()).optional(),
    sessionId: z.string().uuid().optional().nullable(),
  })
  .strict();

const sendChatMessageSchema = z
  .object({
    documentId: z.array(z.string().trim().min(3).max(500)).optional().nullable(),
    question: z.string().trim().min(1).max(4000),
    sessionId: z.string().uuid().optional().nullable(),
    preferredLanguage: z.string().optional(),
  })
  .strict();

const sessionMessagesQuerySchema = z
  .object({
    cursor: z.string().trim().min(1).optional(),
    limit: z.coerce.number().int().positive().max(100).default(20),
    direction: z.enum(["before", "after"]).default("before"),
  })
  .strict();

const sessionListQuerySchema = z
  .object({
    cursor: z.string().trim().min(1).optional(),
    limit: z.coerce.number().int().positive().max(100).default(20),
  })
  .strict();

const unifiedChatSchema = z.object({
  actionType: z.string().trim().optional().nullable(),
  actionData: z.record(z.any()).optional().nullable(),
  message: z.string().trim().max(4000).optional().nullable(),
  question: z.string().trim().max(4000).optional().nullable(),
  sessionId: z.string().uuid().optional().nullable(),
  documentId: z
    .union([z.string().trim(), z.array(z.string().trim())])
    .optional()
    .nullable(),
  state: z.record(z.any()).optional().nullable(),
  history: z.array(z.record(z.any())).optional().default([]),
  displayLabel: z.string().optional().nullable(),
  preferredLanguage: z.string().optional().nullable(),
});

/* Backup of original module.exports:
module.exports = {
  addDocumentSchema,
  batchFileKeySchema,
  createChatSessionSchema,
  fileKeySchema,
  runOcrSchema,
  sendChatMessageSchema,
  sessionListQuerySchema,
  sessionMessagesQuerySchema,
};
*/

module.exports = {
  addDocumentSchema,
  batchFileKeySchema,
  createChatSessionSchema,
  fileKeySchema,
  runOcrSchema,
  sendChatMessageSchema,
  sessionListQuerySchema,
  sessionMessagesQuerySchema,
  unifiedChatSchema,
};
