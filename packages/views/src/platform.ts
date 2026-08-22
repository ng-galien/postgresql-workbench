/**
 * Which chord this reader's keyboard uses for the one an editor calls "the modifier": ⌘ on a Mac,
 * Ctrl everywhere else.
 *
 * Asked once per surface and answered once here, because the three surfaces that asked it before
 * asked it three different ways — and one of them at module scope, which is answered before a page
 * has a `navigator` at all when the view is rendered to a string.
 */
export function onMac(): boolean {
  return typeof navigator !== "undefined" && /mac/iu.test(navigator.userAgent);
}

/** The chord as a reader would read it in a sentence: `Cmd+click`, `Ctrl+click`. */
export function chordName(): string {
  return onMac() ? "Cmd" : "Ctrl";
}

/** The chord as a key cap, beside the key it is pressed with: `⌘K`, `Ctrl K`. */
export function chordCap(key: string): string {
  return onMac() ? `⌘${key}` : `Ctrl ${key}`;
}
