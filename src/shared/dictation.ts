export interface DictationAlternative {
  transcript?: string;
}

export interface DictationResult extends ArrayLike<DictationAlternative> {
  isFinal?: boolean;
}

export function transcriptFromResults(results: ArrayLike<DictationResult>): string {
  const segments: string[] = [];
  for (let index = 0; index < results.length; index += 1) {
    const text = results[index]?.[0]?.transcript?.trim();
    if (text) segments.push(text);
  }
  return segments.reduce((transcript, segment) => `${transcript}${needsSeparator(transcript, segment) ? ' ' : ''}${segment}`, '');
}

function needsSeparator(left: string, right: string): boolean {
  const leftCharacter = Array.from(left).at(-1) || '';
  const rightCharacter = Array.from(right)[0] || '';
  if (!leftCharacter || !rightCharacter || /\s/.test(leftCharacter) || /\s/.test(rightCharacter)) return false;
  if (/^[\p{P}\p{S}]$/u.test(rightCharacter)) return false;
  if (/^[\p{P}\p{S}]$/u.test(leftCharacter)) {
    if (/^[，。！？；：、」』）】》〉]$/u.test(leftCharacter) || /^[([{“‘]$/u.test(leftCharacter)) return false;
    return /\p{Script=Latin}/u.test(rightCharacter) || /\p{N}/u.test(rightCharacter);
  }
  const han = /\p{Script=Han}/u;
  if (han.test(leftCharacter) && han.test(rightCharacter)) return false;
  return /[\p{L}\p{N}]/u.test(leftCharacter) && /[\p{L}\p{N}]/u.test(rightCharacter);
}

export function insertDictation(draft: string, transcript: string, selectionStart = draft.length, selectionEnd = selectionStart): string {
  const text = transcript.trim();
  if (!text) return draft;
  const start = Math.max(0, Math.min(draft.length, selectionStart));
  const end = Math.max(start, Math.min(draft.length, selectionEnd));
  const prefix = draft.slice(0, start);
  const suffix = draft.slice(end);
  const before = needsSeparator(prefix, text) ? ' ' : '';
  const after = needsSeparator(text, suffix) ? ' ' : '';
  return `${prefix}${before}${text}${after}${suffix}`;
}
