/**
 * Token estimation.
 *
 * V1 uses a character-based heuristic, not a real tokenizer.
 * To plug in a model specific tokenizer later, implement `TokenEstimator`
 * and pass it where `defaultTokenEstimator` is used.
 */
export interface TokenEstimator {
  readonly name: string;
  estimate(text: string): number;
}

/**
 * Rough rules of thumb for Claude-family tokenizers:
 * - English / code: about 4 characters per token
 * - Korean, Japanese, Chinese: about 1 token per 1.5 characters
 */
export const charBasedTokenEstimator: TokenEstimator = {
  name: 'char-heuristic-v1',
  estimate(text: string): number {
    if (text.length === 0) return 0;
    let asciiChars = 0;
    let otherChars = 0;
    for (const char of text) {
      if (char.charCodeAt(0) < 128) asciiChars += 1;
      else otherChars += 1;
    }
    return Math.ceil(asciiChars / 4 + otherChars / 1.5);
  },
};

export const defaultTokenEstimator: TokenEstimator = charBasedTokenEstimator;
