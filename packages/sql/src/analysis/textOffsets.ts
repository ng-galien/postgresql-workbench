/** Byte offset to UTF-16 offset in one pass, so every syntax-node range is an O(1) lookup. */
export function byteToUtf16Offsets(text: string): (byte: number) => number {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text).length;
  if (bytes === text.length) {
    return (position) => Math.max(0, Math.min(bytes, position));
  }
  const characters = new Uint32Array(bytes + 1);
  let byte = 0;
  let index = 0;
  // By code point: a character outside the BMP is two UTF-16 units but one UTF-8 sequence.
  for (const character of text) {
    const width = encoder.encode(character).length;
    for (let step = 0; step < width; step += 1) characters[byte + step] = index;
    byte += width;
    index += character.length;
  }
  characters[bytes] = text.length;
  return (position) => characters[Math.max(0, Math.min(bytes, position))] ?? text.length;
}
