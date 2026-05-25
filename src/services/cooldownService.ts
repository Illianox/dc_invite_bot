export class CooldownService {
  private readonly expires = new Map<string, number>();

  public take(key: string, durationMs: number): number {
    const now = Date.now();
    const current = this.expires.get(key) ?? 0;
    if (current > now) return current - now;
    this.expires.set(key, now + durationMs);
    return 0;
  }
}
