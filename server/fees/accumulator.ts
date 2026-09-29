/** Converts fee inflows (lamports) into whole paid attempts, carrying the remainder. */
export class FeeAccumulator {
  constructor(private readonly lamportsPerAttempt: number, private remainder = 0) {
    if (!(lamportsPerAttempt > 0)) throw new Error('lamportsPerAttempt must be positive');
  }
  get pending() { return this.remainder; }
  add(lamports: number): number {
    if (!Number.isFinite(lamports) || lamports <= 0) return 0;
    const total = this.remainder + lamports, attempts = Math.floor(total / this.lamportsPerAttempt);
    this.remainder = total - attempts * this.lamportsPerAttempt;
    return attempts;
  }
}
