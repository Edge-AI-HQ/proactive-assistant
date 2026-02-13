export class TelegramStreamProgress {
  private lastPartial = '';

  apply(rawText: string): string | null {
    const text = rawText.trimEnd();
    if (!text) return null;
    if (text === this.lastPartial) return null;

    if (this.lastPartial && this.lastPartial.startsWith(text)) {
      // Ignore regressions caused by non-monotonic partial updates.
      return null;
    }

    this.lastPartial = text;
    return text;
  }

  reset(): void {
    this.lastPartial = '';
  }
}
