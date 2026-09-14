const moment = require("moment-timezone");
const {
  generateReminderOccurrences,
  matchesSpecificDays,
  parseTime,
  convertToUserTimeZone,
} = require("../../src/utils/reminderOccurrenceGenerator");
const { reminderOccurrenceStatus } = require("../../src/enums/reminderOccurrenceStatus");

describe("Medication Recurrence Engine & Multi-Timezone DST Tests", () => {
  const baseReminder = { id: "reminder-uuid-1" };
  const baseMedication = {
    id: "med-uuid-1",
    userId: "user-uuid-1",
    medicationName: "Metformin 500mg",
    dosePerIntake: 1,
    medicationSchedule: {
      Morning: "08:00:00",
    },
    timezone: "Asia/Kolkata",
    totalQuantity: 10,
    remainingQuantity: 10,
    startDate: "2026-05-01T00:00:00.000Z",
  };

  describe("1. Basic Parsing & Schedule Extraction", () => {
    test("parseTime correctly parses HH:mm:ss and handles malformed inputs", () => {
      expect(parseTime("08:30:00")).toEqual({ hours: 8, minutes: 30, seconds: 0 });
      expect(parseTime("21:15:45")).toEqual({ hours: 21, minutes: 15, seconds: 45 });
      expect(parseTime("invalid")).toEqual({ hours: 8, minutes: 0, seconds: 0 });
      expect(parseTime(null)).toEqual({ hours: 8, minutes: 0, seconds: 0 });
    });

    test("matchesSpecificDays matches day names and numeric indices", () => {
      // 2026-05-01 is a Friday (day 5)
      const friday = moment.tz("2026-05-01", "Asia/Kolkata");
      expect(matchesSpecificDays(friday, ["Friday"])).toBe(true);
      expect(matchesSpecificDays(friday, ["fri", "mon"])).toBe(true);
      expect(matchesSpecificDays(friday, [5])).toBe(true);
      expect(matchesSpecificDays(friday, ["Monday", "Wednesday"])).toBe(false);
      expect(matchesSpecificDays(friday, [1, 3])).toBe(false);
      expect(matchesSpecificDays(friday, [])).toBe(true); // Empty array defaults to all days
    });
  });

  describe("2. Recurrence Frequencies: DAILY, SPECIFIC_DAYS, INTERVAL", () => {
    test("DAILY frequency generates consecutive daily occurrences until quantity exhausted", () => {
      const med = {
        ...baseMedication,
        frequency: "Once Daily",
        totalQuantity: 5,
        remainingQuantity: 5,
        startDate: "2026-06-01T00:00:00.000Z",
      };

      const occurrences = generateReminderOccurrences(
        baseReminder,
        med,
        "2026-06-01T00:00:00.000Z",
        {
          skipPastOccurrences: false,
        },
      );

      expect(occurrences).toHaveLength(5);
      occurrences.forEach((occ, idx) => {
        const expectedDateStr = `2026-06-0${idx + 1}`;
        const localStr = moment(occ.actualMedicationTime).tz(med.timezone).format("YYYY-MM-DD");
        expect(localStr).toBe(expectedDateStr);
        expect(occ.status).toBe(reminderOccurrenceStatus.PENDING);
      });
    });

    test("SPECIFIC_DAYS frequency generates doses ONLY on designated days of week", () => {
      // 2026-06-01 is Monday
      const med = {
        ...baseMedication,
        frequency: "SPECIFIC_DAYS",
        medicationSchedule: {
          Morning: "09:00:00",
          specificDays: ["Monday", "Wednesday", "Friday"],
        },
        totalQuantity: 6, // 2 weeks worth (Mon, Wed, Fri, Mon, Wed, Fri)
        remainingQuantity: 6,
        startDate: "2026-06-01T00:00:00.000Z",
      };

      const occurrences = generateReminderOccurrences(
        baseReminder,
        med,
        "2026-06-01T00:00:00.000Z",
        {
          skipPastOccurrences: false,
        },
      );

      expect(occurrences).toHaveLength(6);
      const generatedDays = occurrences.map((occ) =>
        moment(occ.actualMedicationTime).tz(med.timezone).format("dddd"),
      );

      expect(generatedDays).toEqual([
        "Monday",
        "Wednesday",
        "Friday",
        "Monday",
        "Wednesday",
        "Friday",
      ]);
    });

    test("INTERVAL frequency steps calendar dates by intervalDays", () => {
      // Every 3 days starting 2026-06-01
      const med = {
        ...baseMedication,
        frequency: "INTERVAL",
        medicationSchedule: {
          Morning: "10:00:00",
          intervalDays: 3,
        },
        totalQuantity: 4,
        remainingQuantity: 4,
        startDate: "2026-06-01T00:00:00.000Z",
      };

      const occurrences = generateReminderOccurrences(
        baseReminder,
        med,
        "2026-06-01T00:00:00.000Z",
        {
          skipPastOccurrences: false,
        },
      );

      expect(occurrences).toHaveLength(4);
      const dates = occurrences.map((occ) =>
        moment(occ.actualMedicationTime).tz(med.timezone).format("YYYY-MM-DD"),
      );

      expect(dates).toEqual(["2026-06-01", "2026-06-04", "2026-06-07", "2026-06-10"]);
    });
  });

  describe("3. Multi-Timezone & Daylight Saving Time (DST) Safety", () => {
    test("America/New_York across Spring Forward DST transition maintains exact 08:00 AM local time", () => {
      // US DST Spring Forward occurs on Sunday March 8, 2026 at 2:00 AM (EST -> EDT)
      // Before DST (Mar 7): 08:00 AM EST is 13:00 UTC
      // After DST (Mar 9): 08:00 AM EDT is 12:00 UTC
      const med = {
        ...baseMedication,
        timezone: "America/New_York",
        medicationSchedule: {
          Morning: "08:00:00",
        },
        totalQuantity: 4,
        remainingQuantity: 4,
        startDate: "2026-03-06T00:00:00.000Z",
      };

      const occurrences = generateReminderOccurrences(
        baseReminder,
        med,
        "2026-03-06T00:00:00.000Z",
        {
          skipPastOccurrences: false,
        },
      );

      expect(occurrences).toHaveLength(4);

      // Verify all occurrences in local time format to exactly 08:00 AM
      occurrences.forEach((occ) => {
        const localFormatted = convertToUserTimeZone(occ.actualMedicationTime, "America/New_York");
        expect(localFormatted).toBe("08:00 AM");
      });

      // Verify UTC shift across the transition
      const mar7 = occurrences[1].actualMedicationTime; // March 7 (EST: UTC-5)
      const mar9 = occurrences[3].actualMedicationTime; // March 9 (EDT: UTC-4)

      expect(mar7.getUTCHours()).toBe(13); // 8 + 5 = 13:00 UTC
      expect(mar9.getUTCHours()).toBe(12); // 8 + 4 = 12:00 UTC
    });

    test("Month-end rollover (Jan 31 -> Feb 1) seamlessly advances calendar dates", () => {
      const med = {
        ...baseMedication,
        totalQuantity: 3,
        remainingQuantity: 3,
        startDate: "2026-01-30T00:00:00.000Z",
      };

      const occurrences = generateReminderOccurrences(
        baseReminder,
        med,
        "2026-01-30T00:00:00.000Z",
        {
          skipPastOccurrences: false,
        },
      );

      expect(occurrences).toHaveLength(3);
      const dates = occurrences.map((occ) =>
        moment(occ.actualMedicationTime).tz(med.timezone).format("YYYY-MM-DD"),
      );

      expect(dates).toEqual(["2026-01-30", "2026-01-31", "2026-02-01"]);
    });

    test("Ongoing medication without specified quantity caps at 30 days", () => {
      const med = {
        ...baseMedication,
        totalQuantity: 0,
        remainingQuantity: 0,
        ongoing: true,
        startDate: "2026-07-01T00:00:00.000Z",
      };

      const occurrences = generateReminderOccurrences(
        baseReminder,
        med,
        "2026-07-01T00:00:00.000Z",
        {
          skipPastOccurrences: false,
        },
      );

      // Exactly 30 days
      expect(occurrences).toHaveLength(30);
    });
  });
});
