import type { DebugResultCell } from "../../../dap/src/debugger/launch/index.js";
import { onMac } from "../platform.js";

/**
 * What a cell holds, once it is worth more than one line. The grid shows every value the same way
 * — one line, cut where the column ends — which is all a row of a table can do. This says what the
 * value actually is, so a panel beside the grid can show it as that thing rather than as text.
 *
 * It decides the shape and leaves the drawing to whoever asked: nothing here knows about a view.
 */
export type CellDetail =
  /** A JSON document, laid out. */
  | { shape: "json"; text: string }
  /** A list in one cell, taken apart. */
  | { shape: "list"; items: string[] }
  /**
   * Bytes: how many, what they look like, and the first of them. `image` carries the whole of them
   * when they are a picture that arrived intact, so a panel can show the picture rather than
   * describe it — a name and a byte count are what is left when it cannot.
   */
  | {
      shape: "binary";
      bytes: number;
      looksLike?: string;
      head: string;
      truncated: boolean;
      image?: { mediaType: string; hex: string };
    }
  /** An address that leads somewhere. */
  | { shape: "link"; href: string }
  /** Anything else, whole. */
  | { shape: "text"; text: string }
  /** No value at all. */
  | { shape: "empty" };

/** What the first bytes of a value say it is; nothing, when they say nothing. */
const MAGIC: { prefix: string; name: string; mediaType?: string }[] = [
  { prefix: "89504e470d0a1a0a", name: "PNG image", mediaType: "image/png" },
  { prefix: "ffd8ff", name: "JPEG image", mediaType: "image/jpeg" },
  { prefix: "47494638", name: "GIF image", mediaType: "image/gif" },
  { prefix: "25504446", name: "PDF document" },
  { prefix: "504b0304", name: "ZIP archive" },
  { prefix: "1f8b", name: "gzip archive" },
  { prefix: "377abcaf271c", name: "7z archive" },
  { prefix: "52494646", name: "RIFF container (WAV, WebP, AVI)" },
  { prefix: "00000018667479", name: "MP4 video" },
  { prefix: "3c3f786d6c", name: "XML document" },
];

export function cellDetail(cell: DebugResultCell, typeName?: string): CellDetail {
  if (cell.value === null) return { shape: "empty" };
  if (cell.kind === "binary") return binaryDetail(cell.value, cell.truncated === true);
  if (
    cell.kind === "json" &&
    (typeName === undefined || typeName === "json" || typeName === "jsonb")
  ) {
    return jsonDetail(cell.value);
  }
  const items = postgresArrayItems(cell.value, typeName);
  if (items) return { shape: "list", items };
  if (isWebAddress(cell.value)) return { shape: "link", href: cell.value.trim() };
  return { shape: "text", text: cell.value };
}

/** Whether a value is an address a reader could follow, and nothing else besides. */
export function isWebAddress(value: string): boolean {
  return /^https?:\/\/\S+$/u.test(value.trim());
}

/**
 * The class the text a cell draws for an address carries, and what counts as asking for it.
 *
 * Both sides of the gesture are named here rather than agreed on in passing: the row draws the
 * marked text and decides which clicks belong to it, the grid's menu asks for the same thing without
 * one. Following it is nobody's business here — a view says what was asked for and the host that
 * put it on screen opens it.
 */
export const CELL_LINK = "cell-link";

/**
 * Whether a click on a cell's address is asking for the address rather than for the cell: the
 * chord every editor uses for a link, named for the platform it is pressed on.
 *
 * The grid's own click belongs to selection, so nothing else follows — the pointer reaches the
 * link through the mark the cell draws, and the keyboard through the cell menu.
 */
export function followsCellLink(event: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return onMac() ? event.metaKey : event.ctrlKey;
}

/** A document laid out over several lines, or plain text when it cannot be parsed. */
function jsonDetail(value: string): CellDetail {
  try {
    return { shape: "json", text: JSON.stringify(JSON.parse(value), null, 2) };
  } catch {
    return { shape: "text", text: value };
  }
}

function binaryDetail(value: string, truncated: boolean): CellDetail {
  const hex = value.replace(/^\\x/u, "").replace(/…$/u, "");
  const bytes = Math.floor(hex.length / 2);
  const magic = MAGIC.find((candidate) => hex.toLowerCase().startsWith(candidate.prefix));
  // A picture cut short is not a picture: half a PNG draws nothing, so it is described instead.
  const image = !truncated && magic?.mediaType ? { mediaType: magic.mediaType, hex } : undefined;
  return {
    shape: "binary",
    bytes,
    ...(magic ? { looksLike: magic.name } : {}),
    ...(image ? { image } : {}),
    // Grouped in pairs, the way every hex dump a reader has seen is.
    head: (hex.match(/.{1,2}/gu) ?? []).slice(0, 32).join(" "),
    truncated,
  };
}

/**
 * The items of a PostgreSQL array literal — `{a,b,"c,d"}` — or nothing when the value is not one.
 * A quoted item keeps its commas and its braces, and a backslash escapes the character after it.
 * `NULL` unquoted is PostgreSQL's null element and is kept as the word, because a list has no way
 * to show an absent item and pretending otherwise would lose it.
 */
export function postgresArrayItems(value: string, typeName?: string): string[] | undefined {
  if (typeName !== undefined && !typeName.endsWith("[]")) return undefined;
  const text = value.trim();
  if (!text.startsWith("{") || !text.endsWith("}")) return undefined;
  const body = text.slice(1, -1);
  if (body.trim() === "") return [];
  const items: string[] = [];
  let item = "";
  let quoted = false;
  let at = 0;
  while (at < body.length) {
    const character = body[at] ?? "";
    if (quoted) {
      if (character === "\\") {
        item += body[at + 1] ?? "";
        at += 2;
        continue;
      }
      if (character === '"') {
        quoted = false;
        at += 1;
        continue;
      }
      item += character;
      at += 1;
      continue;
    }
    if (character === '"' && item === "") {
      quoted = true;
      at += 1;
      continue;
    }
    if (character === ",") {
      items.push(item);
      item = "";
      at += 1;
      continue;
    }
    item += character;
    at += 1;
  }
  items.push(item);
  return items;
}
