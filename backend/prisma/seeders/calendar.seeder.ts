import { PrismaClient } from '@prisma/client';

export interface CalendarSeederOptions {
  startYear?: number;
  endYear?: number;
  holidays?: string[]; // Format: 'YYYY-MM-DD'
}

// Configurable Kazakhstan public holidays (default sample for 2026-2027)
const DEFAULT_HOLIDAYS = [
  // 2026
  '2026-01-01', '2026-01-02', '2026-01-07',
  '2026-03-08', '2026-03-21', '2026-03-22', '2026-03-23',
  '2026-05-01', '2026-05-07', '2026-05-09',
  '2026-07-06', '2026-08-30', '2026-10-25', '2026-12-16',
  // 2027
  '2027-01-01', '2027-01-02', '2027-01-07',
  '2027-03-08', '2027-03-21', '2027-03-22', '2027-03-23',
  '2027-05-01', '2027-05-07', '2027-05-09',
  '2027-07-06', '2027-08-30', '2027-10-25', '2027-12-16'
];

/**
 * Calculates ISO 8601 week number.
 */
function getIsoWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

export async function seedWorkCalendar(prisma: PrismaClient, options?: CalendarSeederOptions) {
  const startYear = options?.startYear ?? new Date().getFullYear();
  const endYear = options?.endYear ?? startYear + 1;
  const holidaySet = new Set(options?.holidays ?? DEFAULT_HOLIDAYS);

  const daysToCreate = [];
  let cumulativeWorkingDayNo = 0;
  let currentYear = startYear;

  const startDate = new Date(Date.UTC(startYear, 0, 1));
  const endDate = new Date(Date.UTC(endYear, 11, 31));

  for (let d = new Date(startDate); d <= endDate; d.setUTCDate(d.getUTCDate() + 1)) {
    const year = d.getUTCFullYear();
    if (year !== currentYear) {
      currentYear = year;
      cumulativeWorkingDayNo = 0; // Reset counter for new calendar year
    }

    const isoString = d.toISOString().split('T')[0];
    const dayOfWeek = d.getUTCDay(); // 0 = Sunday, 6 = Saturday
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    const isHoliday = holidaySet.has(isoString);
    const isWorkingDay = !isWeekend && !isHoliday;

    if (isWorkingDay) {
      cumulativeWorkingDayNo++;
    }

    daysToCreate.push({
      date: new Date(isoString),
      weekNumber: getIsoWeekNumber(d),
      isWorkingDay,
      cumulativeWorkingDayNo,
    });
  }

  // Batch insert into database
  await prisma.workCalendarDay.createMany({
    data: daysToCreate,
    skipDuplicates: true,
  });

  console.log(`Seeded ${daysToCreate.length} calendar days for years ${startYear}-${endYear}`);
}
