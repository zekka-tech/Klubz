export const TRIP_RATES = {
  DAILY_PER_KM: 2.85,
  MONTHLY_PER_KM: 2.15,
  ROAD_FACTOR: 1.3,     // straight-line -> road distance multiplier
  AVG_SPEED_KMH: 35,    // urban average for ETA
} as const;

export type TripType = 'daily' | 'monthly';

/** Fare in ZAR cents: distanceKm x rate */
export function calculateFareCents(distanceKm: number, tripType: TripType): number {
  const rate = tripType === 'monthly' ? TRIP_RATES.MONTHLY_PER_KM : TRIP_RATES.DAILY_PER_KM;
  return Math.round(distanceKm * rate * 100);
}

/** ETA in minutes: distanceKm / avgSpeed x 60, minimum 5 min */
export function estimateETAMinutes(distanceKm: number): number {
  return Math.max(5, Math.round((distanceKm / TRIP_RATES.AVG_SPEED_KMH) * 60));
}

/** Haversine great-circle distance in km */
export function haversineKm(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
): number {
  const R = 6371;
  const dLat = ((to.lat - from.lat) * Math.PI) / 180;
  const dLng = ((to.lng - from.lng) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((from.lat * Math.PI) / 180) *
      Math.cos((to.lat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Estimated road distance from straight-line */
export function estimatedRoadKm(straightLineKm: number): number {
  return straightLineKm * TRIP_RATES.ROAD_FACTOR;
}

/** Generate all YYYY-MM-DD dates for a month that fall on the given ISO weekdays */
export function generateScheduledDates(
  month: string,            // YYYY-MM
  recurringWeekdays: number[], // ISO: 1=Mon ... 7=Sun
): string[] {
  const [y, m] = month.split('-').map(Number);
  const dates: string[] = [];
  const daysInMonth = new Date(y, m, 0).getDate();
  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(y, m - 1, d);
    // getDay(): 0=Sun,1=Mon...6=Sat -> convert to ISO: Sun=7
    const iso = date.getDay() === 0 ? 7 : date.getDay();
    if (recurringWeekdays.includes(iso)) {
      dates.push(`${month}-${String(d).padStart(2, '0')}`);
    }
  }
  return dates;
}

/** Monthly total estimate */
export function estimateMonthlyTotal(
  avgKmPerTrip: number,
  scheduledDates: string[],
  includeEvening: boolean,
): { totalCents: number; totalKm: number; totalDays: number; totalTrips: number } {
  const tripsPerDay = includeEvening ? 2 : 1;
  const totalTrips = scheduledDates.length * tripsPerDay;
  const totalKm = avgKmPerTrip * totalTrips;
  const totalCents = calculateFareCents(totalKm, 'monthly');
  return { totalCents, totalKm, totalDays: scheduledDates.length, totalTrips };
}

/** Parse HH:MM string to minutes since midnight */
export function parseTimeToMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

/** Add minutes to a HH:MM string, returns HH:MM */
export function addMinutesToTime(time: string, deltaMinutes: number): string {
  const total = parseTimeToMinutes(time) + deltaMinutes;
  const h = Math.floor(((total % 1440) + 1440) % 1440 / 60);
  const m = ((total % 1440) + 1440) % 1440 % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
