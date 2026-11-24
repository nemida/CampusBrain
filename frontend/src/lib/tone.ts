import type { CSSProperties } from "react";

/** Hues that sit well with the green/paper palette (oklch hue angles). */
const HUES = [160, 250, 70, 20, 300, 200, 120, 340] as const;

function hash(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Stable hue for any string (a subject id, a unit title...), so the same thing is always the same colour. */
export function toneHue(key: string): number {
  return HUES[hash(key) % HUES.length]!;
}

/** Hue by position, for lists where neighbours must differ. */
export function toneHueAt(index: number): number {
  return HUES[((index % HUES.length) + HUES.length) % HUES.length]!;
}

/**
 * Spread on an element to switch on the tone utilities (`tone-bg-soft`, `tone-text`, `tone-border`,
 * `tone-accent-l`, `tone-dot`, `chip-tone`) for that element and everything inside it.
 */
export function toneStyle(keyOrIndex: string | number): CSSProperties {
  const hue = typeof keyOrIndex === "number" ? toneHueAt(keyOrIndex) : toneHue(keyOrIndex);
  return { ["--hue" as string]: hue } as CSSProperties;
}
