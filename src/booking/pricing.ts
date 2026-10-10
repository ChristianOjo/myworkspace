export function hourlyPriceCents(rateCents: number, minutes: number): number {
  return Math.round(rateCents * minutes / 60);
}