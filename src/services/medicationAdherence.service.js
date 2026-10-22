const medicationReminderOccurrenceRepository = require("../repositories/medicationReminderOccurrenceRepository");
const medicationRepository = require("../repositories/medicationRepository");
const refillRepository = require("../repositories/refillRepository");
const patientRepository = require("../repositories/patientRepository");
const { isValidTimezone } = require("../validations/adherenceDashboardValidation");

function getPatientLocalToday(timezone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const y = parts.find((p) => p.type === "year").value;
  const m = parts.find((p) => p.type === "month").value;
  const d = parts.find((p) => p.type === "day").value;
  return `${y}-${m}-${d}`;
}

function getDayLabel(dateStr, timezone) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dateUtc = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
  }).format(dateUtc);
}

function formatTime12Hour(dateInput, timezone) {
  if (!dateInput) return null;
  const d = new Date(dateInput);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(d);
}

function formatDelayString(delayMinutes, classification) {
  if (delayMinutes === null || delayMinutes === undefined) return null;
  if (classification === "LATE" || delayMinutes > 0) {
    const h = Math.floor(delayMinutes / 60);
    const m = delayMinutes % 60;
    if (h > 0 && m > 0) return `${h}h ${m}m late`;
    if (h > 0) return `${h}h late`;
    return `${m}m late`;
  }
  if (delayMinutes < 0) {
    return `${Math.abs(delayMinutes)}m early`;
  }
  return "On time";
}

function addDaysToDateStr(dateStr, daysToAdd) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + daysToAdd, 12, 0, 0));
  const rY = dt.getUTCFullYear();
  const rM = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const rD = String(dt.getUTCDate()).padStart(2, "0");
  return `${rY}-${rM}-${rD}`;
}

function generateDateRange(startDateStr, endDateStr) {
  const dates = [];
  let curr = startDateStr;
  while (curr <= endDateStr) {
    dates.push(curr);
    curr = addDaysToDateStr(curr, 1);
  }
  return dates;
}

const DEFAULT_REFILL_THRESHOLDS = Object.freeze({
  LOW_STOCK_DAYS: 3,
  DUE_SOON_DAYS: 7,
});

function calculateRefillUrgency({
  remainingQuantity,
  dailyConsumption,
  isAsNeeded = false,
  lowStockThresholdDays = DEFAULT_REFILL_THRESHOLDS.LOW_STOCK_DAYS,
  dueSoonThresholdDays = DEFAULT_REFILL_THRESHOLDS.DUE_SOON_DAYS,
}) {
  if (remainingQuantity <= 0) {
    return {
      urgency: "OUT_OF_STOCK",
      daysRemaining: 0,
    };
  }

  // For AS_NEEDED or irregular schedules where daily consumption cannot be calculated:
  // Do not invent daily consumption; safely classify as HEALTHY without false alarms.
  if (isAsNeeded || !dailyConsumption || dailyConsumption <= 0) {
    return {
      urgency: "HEALTHY",
      daysRemaining: null,
    };
  }

  const daysRemaining = Math.floor(remainingQuantity / dailyConsumption);

  if (daysRemaining <= lowStockThresholdDays) {
    return {
      urgency: "LOW_STOCK",
      daysRemaining,
    };
  }

  if (daysRemaining <= dueSoonThresholdDays) {
    return {
      urgency: "DUE_SOON",
      daysRemaining,
    };
  }

  return {
    urgency: "HEALTHY",
    daysRemaining,
  };
}

class MedicationAdherenceService {
  constructor() {
    this.DEFAULT_REFILL_THRESHOLDS = DEFAULT_REFILL_THRESHOLDS;
  }

  async resolveTimezone(userId, reqTimezone) {
    if (isValidTimezone(reqTimezone)) return reqTimezone;
    if (userId) {
      try {
        const pat = await patientRepository.findById(userId);
        if (pat && isValidTimezone(pat.timezone)) {
          return pat.timezone;
        }
      } catch {
        // Fallback below
      }
    }
    return "Asia/Kolkata";
  }

  async getWeeklyAdherence(userId, query = {}) {
    const timezone = await this.resolveTimezone(userId, query.timezone);
    const todayStr = getPatientLocalToday(timezone);
    const endDateStr = query.endDate || todayStr;
    const startDateStr = query.startDate || addDaysToDateStr(endDateStr, -6);

    const rows = await medicationReminderOccurrenceRepository.getWeeklyAdherenceOccurrences(
      userId,
      {
        startDate: startDateStr,
        endDate: endDateStr,
        timezone,
      },
    );

    const rowsByDate = {};
    for (const r of rows) {
      rowsByDate[r.date] = r;
    }

    const allDates = generateDateRange(startDateStr, endDateStr);
    const dailyBreakdown = allDates.map((dStr) => {
      const match = rowsByDate[dStr] || {};
      const completedEarly = Number(match.completedEarly || 0);
      const completedOnTime = Number(match.completedOnTime || 0);
      const completedLate = Number(match.completedLate || 0);
      const completedUnknown = Number(match.completedUnknown || 0);
      const overdue = Number(match.overdue || 0);
      const missed = Number(match.missed || 0);
      const pending = Number(match.pending || 0);
      const skipped = Number(match.skipped || 0);
      const total =
        Number(match.total) ||
        completedEarly +
          completedOnTime +
          completedLate +
          completedUnknown +
          overdue +
          missed +
          pending +
          skipped;

      return {
        date: dStr,
        dayLabel: getDayLabel(dStr, timezone),
        isToday: dStr === todayStr,
        completedEarly,
        completedOnTime,
        completedLate,
        completedUnknown,
        overdue,
        missed,
        pending,
        skipped,
        total,
      };
    });

    const kpiSummary = dailyBreakdown.reduce(
      (acc, day) => {
        acc.totalScheduled += day.total;
        acc.completedEarly += day.completedEarly;
        acc.completedOnTime += day.completedOnTime;
        acc.completedLate += day.completedLate;
        acc.completedUnknown += day.completedUnknown;
        acc.overdue += day.overdue;
        acc.missed += day.missed;
        acc.pending += day.pending;
        acc.skipped += day.skipped;
        return acc;
      },
      {
        totalScheduled: 0,
        completedEarly: 0,
        completedOnTime: 0,
        completedLate: 0,
        completedUnknown: 0,
        totalCompleted: 0,
        overdue: 0,
        missed: 0,
        pending: 0,
        skipped: 0,
        adherencePercentage: null,
        hasData: false,
      },
    );

    kpiSummary.totalCompleted =
      kpiSummary.completedEarly +
      kpiSummary.completedOnTime +
      kpiSummary.completedLate +
      kpiSummary.completedUnknown;
    const eligibleDoses = kpiSummary.totalCompleted + kpiSummary.overdue + kpiSummary.missed;
    const hasData = eligibleDoses > 0;
    kpiSummary.hasData = hasData;
    kpiSummary.adherencePercentage = hasData
      ? Number(((kpiSummary.totalCompleted / eligibleDoses) * 100).toFixed(1))
      : null;

    return {
      dateRange: {
        startDate: startDateStr,
        endDate: endDateStr,
        timezone,
      },
      kpiSummary,
      dailyBreakdown,
    };
  }

  async getMonthlyAdherence(userId, query = {}) {
    const timezone = await this.resolveTimezone(userId, query.timezone);
    const todayStr = getPatientLocalToday(timezone);
    const [todayYear, todayMonth] = todayStr.split("-").map(Number);

    const month = Number(query.month) || todayMonth;
    const year = Number(query.year) || todayYear;

    const startDateStr = `${year}-${String(month).padStart(2, "0")}-01`;
    const lastDayOfMonth = new Date(year, month, 0).getDate();
    const endDateStr = `${year}-${String(month).padStart(2, "0")}-${String(lastDayOfMonth).padStart(2, "0")}`;

    const monthLabel = new Intl.DateTimeFormat("en-US", {
      month: "long",
      year: "numeric",
      timeZone: timezone,
    }).format(new Date(Date.UTC(year, month - 1, 15)));

    const stats = await medicationReminderOccurrenceRepository.getMonthlyAdherenceOccurrences(
      userId,
      {
        startDate: startDateStr,
        endDate: endDateStr,
        timezone,
      },
    );

    const completedEarly = Number(stats.completedEarly || 0);
    const completedOnTime = Number(stats.completedOnTime || 0);
    const completedLate = Number(stats.completedLate || 0);
    const completedUnknown = Number(stats.completedUnknown || 0);
    const totalCompleted = completedEarly + completedOnTime + completedLate + completedUnknown;
    const overdue = Number(stats.overdue || 0);
    const missed = Number(stats.missed || 0);
    const totalOverdueAndMissed = overdue + missed;
    const pending = Number(stats.pending || 0);
    const skipped = Number(stats.skipped || 0);
    const eligibleScheduledDoses = totalCompleted + totalOverdueAndMissed;
    const totalInMonth = Number(stats.total || 0);
    const hasData = eligibleScheduledDoses > 0;

    const overallAdherence = hasData
      ? Number(((totalCompleted / eligibleScheduledDoses) * 100).toFixed(1))
      : null;

    const onTimeAdherence = hasData
      ? Number(((completedOnTime / eligibleScheduledDoses) * 100).toFixed(1))
      : null;

    const earlyAdherence = hasData
      ? Number(((completedEarly / eligibleScheduledDoses) * 100).toFixed(1))
      : null;

    const lateCompletion = hasData
      ? Number(((completedLate / eligibleScheduledDoses) * 100).toFixed(1))
      : null;

    const unknownCompletion = hasData
      ? Number(((completedUnknown / eligibleScheduledDoses) * 100).toFixed(1))
      : null;

    const overdueAndMissed = hasData
      ? Number(((totalOverdueAndMissed / eligibleScheduledDoses) * 100).toFixed(1))
      : null;

    // Status distribution percentages using total scheduled occurrences in the month as common denominator
    const completedDistribution =
      totalInMonth > 0 ? Number(((totalCompleted / totalInMonth) * 100).toFixed(1)) : 0.0;
    const pendingDistribution =
      totalInMonth > 0 ? Number(((pending / totalInMonth) * 100).toFixed(1)) : 0.0;
    const overdueDistribution =
      totalInMonth > 0 ? Number(((totalOverdueAndMissed / totalInMonth) * 100).toFixed(1)) : 0.0;
    const skippedDistribution =
      totalInMonth > 0 ? Number(((skipped / totalInMonth) * 100).toFixed(1)) : 0.0;

    const overdueRatio =
      totalInMonth > 0 ? Number((totalOverdueAndMissed / totalInMonth).toFixed(3)) : 0.0;
    const completedRatio =
      totalInMonth > 0 ? Number((totalCompleted / totalInMonth).toFixed(3)) : 0.0;
    const pendingRatio = totalInMonth > 0 ? Number((pending / totalInMonth).toFixed(3)) : 0.0;
    const skippedRatio = totalInMonth > 0 ? Number((skipped / totalInMonth).toFixed(3)) : 0.0;

    return {
      month,
      year,
      monthLabel,
      timezone,
      metrics: {
        totalScheduled: totalInMonth,
        eligibleScheduledDoses,
        completedEarly,
        completedOnTime,
        completedLate,
        completedUnknown,
        totalCompleted,
        overdue,
        missed,
        totalOverdueAndMissed,
        pending,
        skipped,
      },
      percentages: {
        hasData,
        overallAdherence,
        onTimeAdherence,
        earlyAdherence,
        lateCompletion,
        unknownCompletion,
        overdueAndMissed,
        completedDistribution,
        pendingDistribution,
        overdueDistribution,
        skippedDistribution,
        pending: pendingDistribution,
        skipped: skippedDistribution,
      },
      segmentedRatios: {
        overdueRatio,
        completedRatio,
        pendingRatio,
        skippedRatio,
      },
    };
  }

  async getDailyDetails(userId, query = {}) {
    const timezone = await this.resolveTimezone(userId, query.timezone);
    const dateStr = query.date;

    const occurrences = await medicationReminderOccurrenceRepository.getDailyOccurrencesWithDetails(
      userId,
      {
        dateStr,
        timezone,
      },
    );

    const rawGrace = process.env.MEDICATION_ON_TIME_GRACE_MINUTES;
    const parsedGrace = rawGrace?.trim() ? Number(rawGrace) : NaN;
    const onTimeGrace = Number.isFinite(parsedGrace) && parsedGrace >= 0 ? parsedGrace : 30;

    const doses = occurrences.map((occ) => {
      let classification = occ.completionClassification;
      let delayMinutes = occ.delayMinutes;
      let retrospectivelyDerived = false;

      if (occ.status === "COMPLETED") {
        if (!classification) {
          if (occ.completedAt && occ.actualMedicationTime) {
            const diffMs =
              new Date(occ.completedAt).getTime() - new Date(occ.actualMedicationTime).getTime();
            delayMinutes = Math.round(diffMs / 60000);
            if (delayMinutes < -5) {
              classification = "EARLY";
            } else if (delayMinutes <= onTimeGrace) {
              classification = "ON_TIME";
            } else {
              classification = "LATE";
            }
            retrospectivelyDerived = true;
          } else {
            classification = "UNKNOWN";
            delayMinutes = null;
          }
        } else if (classification === "ON_TIME" && delayMinutes !== null && delayMinutes < -5) {
          // Derive accurate historical EARLY classification for display without silently rewriting existing records
          classification = "EARLY";
        }
      }

      const scheduledTimeFormatted = formatTime12Hour(occ.actualMedicationTime, timezone);
      const completedAtFormatted = formatTime12Hour(occ.completedAt, timezone);
      const delayFormatted =
        classification === "UNKNOWN"
          ? "Unknown delay"
          : formatDelayString(delayMinutes, classification);
      const actionable = false; // Daily Medication Details is strictly read-only

      return {
        occurrenceId: occ.occurrenceId,
        medicationId: occ.medicationId,
        medicationName: occ.medicationName,
        medicationType: occ.medicationType,
        dosePerIntake: Number(occ.dosePerIntake || 1),
        unit: occ.unit,
        scheduledTime: occ.actualMedicationTime,
        scheduledTimeFormatted,
        completedAt: occ.completedAt,
        completedAtFormatted,
        delayMinutes,
        delayFormatted,
        status: occ.status,
        completionClassification: classification,
        retrospectivelyDerived,
        isOverdue: Boolean(occ.isOverdue),
        skipReason: occ.skipReason || null,
        actionable,
      };
    });

    return {
      date: dateStr,
      timezone,
      totalOccurrences: doses.length,
      doses,
    };
  }

  async getRefillAlerts(userId, query = {}) {
    const timezone = await this.resolveTimezone(userId, query.timezone);
    const todayStr = getPatientLocalToday(timezone);
    const lowStockThresholdDays =
      Number(query.lowStockDays) > 0
        ? Number(query.lowStockDays)
        : DEFAULT_REFILL_THRESHOLDS.LOW_STOCK_DAYS;
    const dueSoonThresholdDays =
      Number(query.dueSoonDays) > 0
        ? Number(query.dueSoonDays)
        : DEFAULT_REFILL_THRESHOLDS.DUE_SOON_DAYS;

    const activeMeds = await medicationRepository.findActiveInventoryMedications(userId);
    if (!activeMeds || activeMeds.length === 0) {
      return {
        hasRefillAlerts: false,
        totalAlertsCount: 0,
        medications: [],
      };
    }

    const alerts = [];
    for (const med of activeMeds) {
      // 1. Refill history lookup
      let hasRefillHistory = false;
      try {
        if (med.hasRefillHistory !== undefined) {
          hasRefillHistory = Boolean(med.hasRefillHistory);
        } else {
          const latestRefill = await refillRepository.findLatestRefillByMedicationId(med.id);
          hasRefillHistory = latestRefill !== null;
        }
      } catch {
        hasRefillHistory = false;
      }

      // 2. Daily consumption derivation
      let dailyConsumption = Number(med.dailyConsumption || 0);
      const dosePerIntake = Number(med.dosePerIntake || 1);
      const isAsNeeded = med.frequency === "AS_NEEDED";

      if (dailyConsumption <= 0 && !isAsNeeded) {
        if (med.medicationSchedule && typeof med.medicationSchedule === "object") {
          const timesPerDay = Object.keys(med.medicationSchedule).length;
          if (timesPerDay > 0) {
            dailyConsumption = Math.ceil(dosePerIntake * timesPerDay);
          }
        }
        if (dailyConsumption <= 0 && med.frequency) {
          if (med.frequency === "ONCE_DAILY") dailyConsumption = Math.ceil(dosePerIntake * 1);
          else if (med.frequency === "TWICE_DAILY") dailyConsumption = Math.ceil(dosePerIntake * 2);
          else if (med.frequency === "THREE_TIMES_DAILY")
            dailyConsumption = Math.ceil(dosePerIntake * 3);
        }
      }

      // 3. Remaining quantity calculation from existing inventory and consumed doses
      let remainingQuantity;
      if (med.remainingQuantity !== undefined && med.remainingQuantity !== null) {
        remainingQuantity = Math.max(0, Number(med.remainingQuantity));
      } else {
        const completedCount =
          await medicationReminderOccurrenceRepository.countCompletedOccurrencesByMedicationId(
            med.id,
          );
        const consumedQuantity = completedCount * dosePerIntake;
        remainingQuantity = Math.max(0, Number(med.totalQuantity || 0) - consumedQuantity);
      }

      const totalQty = Number(med.totalQuantity ?? 0);
      const stockPercentage =
        totalQty > 0 ? Number(((remainingQuantity / totalQty) * 100).toFixed(1)) : 0;

      // 4. Urgency classification (Only OUT_OF_STOCK, LOW_STOCK, DUE_SOON, HEALTHY)
      const urgencyResult = calculateRefillUrgency({
        remainingQuantity,
        dailyConsumption,
        isAsNeeded,
        lowStockThresholdDays,
        dueSoonThresholdDays,
      });

      // 5. Refill date calculation (using upcoming scheduled occurrences when available)
      let estimatedRefillDate = null;
      if (urgencyResult.urgency !== "HEALTHY") {
        const nextDoseDate = med.nextDose || null;
        let shortageDateFromOccurrences = null;

        if (
          med.id &&
          typeof medicationReminderOccurrenceRepository.findUpcomingOccurrencesByMedicationId ===
            "function"
        ) {
          try {
            const upcoming =
              await medicationReminderOccurrenceRepository.findUpcomingOccurrencesByMedicationId(
                med.id,
                new Date(),
                60,
              );
            if (Array.isArray(upcoming) && upcoming.length > 0) {
              let stockLeft = remainingQuantity;
              for (const occ of upcoming) {
                if (occ.status === "COMPLETED") continue;
                if (stockLeft >= dosePerIntake) {
                  stockLeft -= dosePerIntake;
                } else {
                  const occParts = new Intl.DateTimeFormat("en-US", {
                    timeZone: timezone,
                    year: "numeric",
                    month: "2-digit",
                    day: "2-digit",
                  }).formatToParts(new Date(occ.actualMedicationTime));
                  const y = occParts.find((p) => p.type === "year")?.value;
                  const m = occParts.find((p) => p.type === "month")?.value;
                  const d = occParts.find((p) => p.type === "day")?.value;
                  if (y && m && d) {
                    shortageDateFromOccurrences = `${y}-${m}-${d}`;
                    break;
                  }
                }
              }
            }
          } catch {
            shortageDateFromOccurrences = null;
          }
        }

        if (shortageDateFromOccurrences) {
          estimatedRefillDate = shortageDateFromOccurrences;
        } else if (remainingQuantity <= 0) {
          estimatedRefillDate = nextDoseDate || todayStr;
        } else if (urgencyResult.daysRemaining !== null) {
          const baseDate = nextDoseDate || todayStr;
          estimatedRefillDate = addDaysToDateStr(baseDate, urgencyResult.daysRemaining);
        }
      }

      const isVisible =
        urgencyResult.urgency === "OUT_OF_STOCK" ||
        urgencyResult.urgency === "LOW_STOCK" ||
        urgencyResult.urgency === "DUE_SOON";

      if (isVisible) {
        alerts.push({
          medicationId: med.id,
          medicationName: med.medicationName,
          medicationType: med.medicationType,
          totalQuantity: totalQty,
          remainingQuantity,
          dailyConsumption: dailyConsumption > 0 ? dailyConsumption : null,
          dosePerIntake,
          unit: med.unit,
          daysRemaining: urgencyResult.daysRemaining,
          estimatedRefillDate,
          urgency: urgencyResult.urgency,
          stockPercentage,
          hasRefillHistory,
        });
      }
    }

    const urgencyPriority = {
      OUT_OF_STOCK: 1,
      LOW_STOCK: 2,
      DUE_SOON: 3,
    };

    alerts.sort((a, b) => {
      const prioDiff = (urgencyPriority[a.urgency] || 99) - (urgencyPriority[b.urgency] || 99);
      if (prioDiff !== 0) return prioDiff;
      const daysA = a.daysRemaining !== null ? a.daysRemaining : 999;
      const daysB = b.daysRemaining !== null ? b.daysRemaining : 999;
      return daysA - daysB;
    });

    return {
      hasRefillAlerts: alerts.length > 0,
      totalAlertsCount: alerts.length,
      medications: alerts,
    };
  }
}

const serviceInstance = new MedicationAdherenceService();
serviceInstance.calculateRefillUrgency = calculateRefillUrgency;
serviceInstance.DEFAULT_REFILL_THRESHOLDS = DEFAULT_REFILL_THRESHOLDS;

module.exports = serviceInstance;
