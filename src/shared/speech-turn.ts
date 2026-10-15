export interface FinalSpeechResult extends ArrayLike<{ transcript?: string }> {
  isFinal?: boolean;
}

/** Collects Web Speech final results by stable result index and submits one turn. */
export class SpeechTurnCollector {
  private readonly finalResults = new Map<number, string>();
  private finished = false;

  accept(resultIndex: number, results: ArrayLike<FinalSpeechResult>): void {
    if (this.finished) return;
    const start = Math.max(0, Math.min(results.length, Math.floor(resultIndex)));
    for (let index = start; index < results.length; index += 1) {
      const result = results[index];
      if (!result?.isFinal) continue;
      const transcript = result[0]?.transcript?.trim();
      if (transcript) this.finalResults.set(index, transcript);
    }
  }

  finish(): string {
    if (this.finished) return '';
    this.finished = true;
    return [...this.finalResults.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, transcript]) => transcript)
      .join(' ')
      .trim();
  }
}
