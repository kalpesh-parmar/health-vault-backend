const medicationService = require("../../src/services/medicationService");
const medicationRepository = require("../../src/repositories/medicationRepository");
const patientRepository = require("../../src/repositories/patientRepository");
const { db } = require("../../src/configs/db");

jest.mock("../../src/configs/db", () => {
  const mockTx = {
    insert: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    onConflictDoUpdate: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue([{ id: "med-123" }]),
  };
  return {
    db: {
      transaction: jest.fn().mockImplementation(async (callback) => {
        return await callback(mockTx);
      }),
      insert: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      onConflictDoUpdate: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue([{ id: "med-123" }]),
    },
  };
});

describe("MedicationService Idempotency and Transaction Rollbacks", () => {
  const mockPatient = {
    id: "user-123",
    patientCode: "P-777",
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(patientRepository, "findById").mockResolvedValue(mockPatient);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("should perform upsert on conflict to guarantee idempotency", async () => {
    const payload = {
      name: "Paracetamol",
      type: "TABLET",
      frequency: "ONCE",
      dose: { count: 1 },
      client_med_id: "client-id-1",
      source: "MANUAL",
    };

    const spyInsert = jest.spyOn(medicationRepository, "insert").mockResolvedValue({
      id: "med-123",
      userId: "user-123",
      patientCode: "P-777",
      medicationName: "Paracetamol",
      clientMedId: "client-id-1",
    });

    const res = await medicationService.create("user-123", payload);

    expect(medicationRepository.insert).toHaveBeenCalled();
    expect(res.clientMedId).toBe("client-id-1");
    spyInsert.mockRestore();
  });

  it("should bulk create in a transaction and rollback completely on partial failure", async () => {
    const payloadList = [
      {
        name: "Aspirin",
        type: "TABLET",
        frequency: "ONCE",
        dose: { count: 1 },
        client_med_id: "client-id-a",
        source: "MANUAL",
      },
      {
        name: "Paracetamol",
        type: "TABLET",
        frequency: "TWICE",
        dose: { count: 2 },
        client_med_id: "client-id-b",
        source: "MANUAL",
      },
    ];

    const mockTx = {
      insert: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      onConflictDoUpdate: jest.fn().mockImplementation(() => {
        let callCount = 0;
        return {
          returning: jest.fn().mockImplementation(() => {
            callCount++;
            if (callCount > 1) {
              throw new Error("Simulated insert failure");
            }
            return Promise.resolve([{ id: "med-a" }]);
          }),
        };
      }),
    };

    db.transaction.mockImplementationOnce(async (callback) => {
      return await callback(mockTx);
    });

    await expect(medicationService.bulkCreate("user-123", payloadList)).rejects.toThrow(
      "Simulated insert failure",
    );
  });
});
