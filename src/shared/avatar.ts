import type { DotAppearance } from './types.ts';

export const dotAppearanceOptions = {
  shape: ['circle', 'triangle', 'capsule', 'cat', 'flower', 'heart', 'clover', 'star', 'scallop', 'blob', 'diamond'],
  eyes: ['classic', 'sleepy', 'sparkle', 'wink', 'wide', 'happy', 'heart', 'dot'],
  glasses: ['none', 'round', 'square', 'oval', 'thick', 'winged'],
  accessory: ['none', 'crown', 'halo', 'bow', 'flower', 'leaf', 'sparkle', 'antenna', 'cap'],
} as const;

export const dotCharacters = ['ring', 'smile', 'triangle', 'blue', 'yellow', 'heart', 'frog', 'flower', 'star', 'custom'] as const;
export const dotPets = ['none', 'moss', 'sky', 'aqua', 'ember', 'sun'] as const;

export const dotAvatarPalette = [
  '#f090b5', '#dc8cdb', '#a978f7', '#5983f7', '#4dabf8', '#4fafa9', '#c1cf42', '#f7cf53', '#f19b74',
] as const;

export function isDotAppearance(value: DotAppearance) {
  return dotAppearanceOptions.shape.includes(value.shape as typeof dotAppearanceOptions.shape[number])
    && dotAppearanceOptions.eyes.includes(value.eyes as typeof dotAppearanceOptions.eyes[number])
    && dotAppearanceOptions.glasses.includes(value.glasses as typeof dotAppearanceOptions.glasses[number])
    && dotAppearanceOptions.accessory.includes(value.accessory as typeof dotAppearanceOptions.accessory[number])
    && dotCharacters.includes(value.character as typeof dotCharacters[number])
    && dotPets.includes(value.pet as typeof dotPets[number])
    && /^#[0-9a-fA-F]{6}$/.test(value.color);
}
