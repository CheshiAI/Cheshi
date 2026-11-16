/** Encoded Unicode grams preserve substring searches, including one/two-character Korean terms. */
export const normalizeSearchText = (value: string): string => value.normalize('NFC').toLowerCase();

function grams(value: string, sizes: readonly number[], target: Set<string>): void {
  const characters = Array.from(value, character => character.codePointAt(0)!.toString(16));
  for (let index = 0; index < characters.length; index++) {
    let token = 'g';
    for (let size = 1; size <= 3 && index + size <= characters.length; size++) {
      token += `z${characters[index + size - 1]}`;
      if (sizes.includes(size)) target.add(token);
    }
  }
}

export function indexedGrams(values: readonly string[]): string {
  const tokens = new Set<string>();
  for (const value of values) grams(value, [1, 2, 3], tokens);
  return [...tokens].join(' ');
}

export function queryGrams(terms: readonly string[]): string {
  const tokens = new Set<string>();
  for (const term of terms) grams(term, [Math.min(3, Array.from(term).length)], tokens);
  return [...tokens].join(' AND ');
}
