import zlib from "node:zlib";

// Turn an uploaded file into searchable text.
//
// A vault that stores a PDF but indexes only its filename is a file dump with
// extra steps: nobody can search it, and an agent asking "what did the spec
// say" gets nothing. So every supported format is reduced to plain text at
// upload time, and that text is what lands in the item body.
//
// Deliberately dependency-free. DOCX/PPTX/XLSX are ZIP archives of XML, and
// Node ships the inflate half of ZIP in zlib — so a ~70-line central-directory
// reader covers all of Office. PDF text lives in FlateDecode'd content
// streams, which is the same primitive again. The one thing that genuinely
// needs a library is OCR, and that is scanned pages, which we detect and say
// so about rather than returning silence.

export type Extracted = {
  kind: "text" | "document" | "spreadsheet" | "image" | "binary";
  text: string;
  // Human-facing one-liner for the item body when there is no text (images,
  // unsupported formats). Never invented — it states what was actually found.
  note?: string;
  meta?: Record<string, unknown>;
};

export const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|ya?ml|toml|log|ini|cfg|rst|adoc)$/i;
export const SHEET_EXT = /\.(xlsx|xlsm|csv)$/i;
export const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp)$/i;
export const DOC_EXT = /\.(docx|pptx)$/i;
export const PDF_EXT = /\.pdf$/i;
export const LEGACY_OFFICE_EXT = /\.(doc|ppt|xls)$/i;

// Extracted text is stored in the item body, which is searched and shown. Past
// this it stops being a summary and starts being a payload, so it is cut with
// an explicit marker rather than silently.
export const MAX_EXTRACT_CHARS = 200_000;

const clip = (s: string) =>
  s.length > MAX_EXTRACT_CHARS ? `${s.slice(0, MAX_EXTRACT_CHARS)}\n\n… truncated at ${MAX_EXTRACT_CHARS} characters` : s;

// Collapse the whitespace that document formats produce in abundance, without
// destroying paragraph structure — blank lines carry meaning when a human or an
// agent reads this back.
const tidy = (s: string) =>
  s
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

// ---------------------------------------------------------------- ZIP (OOXML)

type ZipEntry = { name: string; offset: number; method: number; size: number };

// Minimal ZIP directory reader. Only what OOXML needs: stored (0) and deflate
// (8). Reads the central directory rather than scanning for local headers, so
// it cannot be fooled by file data that happens to contain a header signature.
function zipEntries(buf: Buffer): ZipEntry[] {
  const EOCD = 0x06054b50;
  // The end-of-central-directory record sits in the last 64KB (22 bytes plus a
  // comment of at most 65535).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return [];
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count && at + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) break;
    const method = buf.readUInt16LE(at + 10);
    const size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const offset = buf.readUInt32LE(at + 42);
    entries.push({ name: buf.toString("utf8", at + 46, at + 46 + nameLen), offset, method, size });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function zipRead(buf: Buffer, e: ZipEntry): Buffer | null {
  if (e.offset + 30 > buf.length || buf.readUInt32LE(e.offset) !== 0x04034b50) return null;
  // The local header repeats the name/extra lengths, and they can differ from
  // the central directory's — the data starts after the LOCAL ones.
  const nameLen = buf.readUInt16LE(e.offset + 26);
  const extraLen = buf.readUInt16LE(e.offset + 28);
  const start = e.offset + 30 + nameLen + extraLen;
  const data = buf.subarray(start, e.size ? start + e.size : undefined);
  try {
    if (e.method === 0) return Buffer.from(data);
    if (e.method === 8) return zlib.inflateRawSync(data);
  } catch {
    return null;
  }
  return null;
}

// XML → text. Paragraph and line-break elements become newlines first, so the
// output keeps the shape a reader expects instead of one run-on line.
function xmlText(xml: string): string {
  return xml
    .replace(/<\/(w:p|a:p|w:tr)>/g, "\n")
    .replace(/<(w:br|a:br|w:cr)\b[^>]*\/?>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, "&"); // last, so &amp;lt; does not become <
}

function extractOoxml(filename: string, buf: Buffer): Extracted {
  const entries = zipEntries(buf);
  if (!entries.length) return { kind: "binary", text: "", note: "not a readable Office file (no ZIP directory found)" };

  if (/\.docx$/i.test(filename)) {
    // Body, then footnotes/endnotes — content a reader would see, in order.
    const parts: string[] = [];
    for (const name of ["word/document.xml", "word/footnotes.xml", "word/endnotes.xml"]) {
      const e = entries.find((x) => x.name === name);
      const raw = e && zipRead(buf, e);
      if (raw) parts.push(xmlText(raw.toString("utf8")));
    }
    const text = tidy(parts.join("\n\n"));
    return { kind: "document", text, meta: { format: "docx" } };
  }

  // pptx: one section per slide, numbered, because "which slide said that" is
  // the question people actually ask of a deck.
  const slides = entries
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name))
    .sort((a, b) => Number(a.name.match(/(\d+)/)![1]) - Number(b.name.match(/(\d+)/)![1]));
  const notes = entries.filter((e) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(e.name));
  const out: string[] = [];
  slides.forEach((e, i) => {
    const raw = zipRead(buf, e);
    if (!raw) return;
    const body = tidy(xmlText(raw.toString("utf8")));
    if (body) out.push(`## Slide ${i + 1}\n${body}`);
  });
  for (const e of notes) {
    const raw = zipRead(buf, e);
    const body = raw && tidy(xmlText(raw.toString("utf8")));
    if (body) out.push(`## Notes (${e.name.replace(/^.*\//, "")})\n${body}`);
  }
  return { kind: "document", text: tidy(out.join("\n\n")), meta: { format: "pptx", slides: slides.length } };
}

// ------------------------------------------------------------------------ PDF

// Decode one PDF literal string, honouring the escapes the spec defines.
function pdfLiteral(s: string): string {
  return s.replace(/\\(n|r|t|b|f|\(|\)|\\|[0-7]{1,3})/g, (_, esc: string) => {
    switch (esc) {
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case "b":
        return "\b";
      case "f":
        return "\f";
      case "(":
        return "(";
      case ")":
        return ")";
      case "\\":
        return "\\";
      default:
        return String.fromCharCode(parseInt(esc, 8));
    }
  });
}

// Split a PDF string-operand region into its literal (...) and hex <...> parts.
// Written as a scanner rather than a regex because parentheses nest and can be
// escaped, which a regex cannot track.
function pdfStrings(seg: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === "(") {
      let depth = 1;
      let j = i + 1;
      let acc = "";
      while (j < seg.length && depth > 0) {
        const d = seg[j];
        if (d === "\\") {
          acc += d + (seg[j + 1] ?? "");
          j += 2;
          continue;
        }
        if (d === "(") depth++;
        else if (d === ")") {
          depth--;
          if (!depth) break;
        }
        acc += d;
        j++;
      }
      out.push(pdfLiteral(acc));
      i = j;
    } else if (c === "<" && seg[i + 1] !== "<") {
      const end = seg.indexOf(">", i);
      if (end < 0) break;
      const hex = seg.slice(i + 1, end).replace(/[^0-9a-fA-F]/g, "");
      let s = "";
      // Hex strings are usually 2 bytes/glyph for embedded subset fonts and
      // 1 byte for simple ones; 2-byte values below 0xFF are almost always
      // the latter written wide, so decode per byte pair and drop nulls.
      for (let k = 0; k + 1 < hex.length; k += 2) {
        const code = parseInt(hex.slice(k, k + 2), 16);
        if (code) s += String.fromCharCode(code);
      }
      out.push(s);
      i = end;
    }
  }
  return out;
}

// One font's glyph-code → text mapping, from its /ToUnicode CMap.
type CMap = { width: 1 | 2; map: Map<number, string> };

const utf16be = (hex: string): string => {
  let s = "";
  for (let i = 0; i + 3 < hex.length; i += 4) s += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
  // Odd-length (1-byte) destinations do occur; fall back to per-byte.
  if (!s && hex.length >= 2) s = String.fromCharCode(parseInt(hex.slice(0, 2), 16));
  return s;
};

// Parse a ToUnicode CMap: the table a PDF carries precisely so its text can be
// copied back out. Without it, a subset-embedded font's codes are arbitrary
// glyph indices — which is how a naive extractor produces confident gibberish.
function parseCMap(src: string): CMap {
  const map = new Map<number, string>();
  let width: 1 | 2 = 1;
  for (const block of src.match(/beginbfchar[\s\S]*?endbfchar/g) ?? []) {
    for (const m of block.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      if (m[1].length >= 4) width = 2;
      map.set(parseInt(m[1], 16), utf16be(m[2]));
    }
  }
  for (const block of src.match(/beginbfrange[\s\S]*?endbfrange/g) ?? []) {
    // <lo> <hi> <dstStart>  — consecutive codes map to consecutive characters.
    for (const m of block.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      if (m[1].length >= 4) width = 2;
      const lo = parseInt(m[1], 16);
      const hi = parseInt(m[2], 16);
      const base = parseInt(m[3], 16);
      for (let c = lo; c <= hi && c - lo < 65_536; c++) map.set(c, String.fromCharCode(base + (c - lo)));
    }
    // <lo> <hi> [ <d0> <d1> … ] — an explicit destination per code.
    for (const m of block.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*\[([\s\S]*?)\]/g)) {
      if (m[1].length >= 4) width = 2;
      const lo = parseInt(m[1], 16);
      const dsts = [...m[3].matchAll(/<([0-9a-fA-F]+)>/g)].map((d) => utf16be(d[1]));
      dsts.forEach((d, i) => map.set(lo + i, d));
    }
  }
  return { width, map };
}

// Does this look like language, or like glyph indices wearing a costume?
// Real extracted text is mostly letters, digits, spaces and punctuation; a
// mis-decoded subset font is mostly control bytes and symbol soup. Used as a
// backstop so a PDF we cannot honestly read is REPORTED rather than stored.
function looksLikeText(s: string): boolean {
  if (!s) return false;
  let plausible = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (
      (c >= 0x20 && c <= 0x7e) || // printable ASCII
      c === 0x0a ||
      c === 0x09 ||
      (c >= 0xa0 && c <= 0x24f) || // Latin-1/Extended
      (c >= 0x370 && c <= 0x5ff) || // Greek, Cyrillic, Hebrew
      (c >= 0x600 && c <= 0x6ff) || // Arabic
      (c >= 0x3000 && c <= 0x9fff) || // CJK + kana
      (c >= 0xac00 && c <= 0xd7af) // Hangul
    ) {
      plausible++;
    }
  }
  const ratio = plausible / s.length;
  // Letters specifically — a run of "!,0++.-*(" is all printable ASCII but
  // contains almost no letters, which is the signature of glyph indices.
  const letterCount = (s.match(/\p{L}/gu) ?? []).length;
  const alnum = (s.match(/[\p{L}\p{N}]/gu) ?? []).length / s.length;
  // A short sample cannot support a ratio judgement — a one-line receipt is
  // real text, and an 8-character floor rejected exactly those. Below the
  // threshold, require every character to be plausible and at least one to be
  // an actual letter, which "!,0++" fails and "Hi!" passes.
  if (s.length < 12) return ratio === 1 && letterCount > 0;
  return ratio > 0.9 && alnum > 0.35;
}

function extractPdf(buf: Buffer): Extracted {
  const raw = buf.toString("latin1"); // 1 byte ⇄ 1 char, so offsets match

  // Index every object once, so /ToUnicode N 0 R can be resolved.
  const objAt = new Map<number, number>();
  for (const m of raw.matchAll(/(\d+)\s+0\s+obj\b/g)) objAt.set(Number(m[1]), m.index!);

  // PDF 1.5+ packs most objects — including font dictionaries — inside
  // compressed object streams, where a byte scan cannot see them. Without
  // this, per-font /ToUnicode resolution finds nothing on any modern PDF and
  // the only fallback is merging every CMap in the file, which silently maps
  // one font's codes through another's table: right script, wrong characters.
  const objText = new Map<number, string>();
  for (const m of raw.matchAll(/(\d+)\s+0\s+obj\b/g)) {
    const start = m.index!;
    const head = raw.slice(start, start + 600);
    if (!/\/Type\s*\/ObjStm/.test(head)) continue;
    const n = Number(head.match(/\/N\s+(\d+)/)?.[1] ?? 0);
    const first = Number(head.match(/\/First\s+(\d+)/)?.[1] ?? 0);
    if (!n || !first) continue;
    const s = raw.indexOf("stream", start);
    const e = raw.indexOf("endstream", s);
    if (s < 0 || e < 0) continue;
    let from = s + 6;
    if (buf[from] === 0x0d) from++;
    if (buf[from] === 0x0a) from++;
    let body: string;
    try {
      body = zlib.inflateSync(buf.subarray(from, e)).toString("latin1");
    } catch {
      continue;
    }
    // Header: N pairs of "objectNumber byteOffset", offsets relative to /First.
    const nums = body.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i < n; i++) {
      const num = nums[i * 2];
      const off = nums[i * 2 + 1];
      if (!Number.isFinite(num) || !Number.isFinite(off)) continue;
      const nextOff = i + 1 < n ? nums[i * 2 + 3] : undefined;
      objText.set(num, body.slice(first + off, nextOff === undefined ? undefined : first + nextOff));
    }
  }

  const streamOf = (objNum: number): Buffer | null => {
    const start = objAt.get(objNum);
    if (start === undefined) return null;
    const s = raw.indexOf("stream", start);
    const e = raw.indexOf("endstream", s);
    if (s < 0 || e < 0) return null;
    let from = s + 6;
    if (buf[from] === 0x0d) from++;
    if (buf[from] === 0x0a) from++;
    try {
      return zlib.inflateSync(buf.subarray(from, e));
    } catch {
      return Buffer.from(buf.subarray(from, e));
    }
  };

  // Resource name (/F1) → CMap, via the page's /Font dictionary and each font
  // object's /ToUnicode reference. Names are per-resource-dict in principle;
  // in practice they are consistent within a document, and a wrong-but-present
  // mapping still beats raw glyph codes.
  const byName = new Map<string, CMap>();
  const cmapCache = new Map<number, CMap | null>();
  // A font object may sit in the raw bytes or inside an object stream.
  const objBody = (num: number): string | null => {
    const packed = objText.get(num);
    if (packed !== undefined) return packed;
    const at = objAt.get(num);
    return at === undefined ? null : raw.slice(at, at + 2000);
  };
  // Font resource dictionaries live in both places too.
  const dictSources = [raw, ...objText.values()];
  for (const src of dictSources) {
    for (const fd of src.matchAll(/\/Font\s*<<([\s\S]{0,4000}?)>>/g)) {
      for (const pair of fd[1].matchAll(/\/([A-Za-z0-9.+-]+)\s+(\d+)\s+0\s+R/g)) {
        const name = pair[1];
        if (byName.has(name)) continue;
        const fbody = objBody(Number(pair[2]));
        const tu = fbody?.match(/\/ToUnicode\s+(\d+)\s+0\s+R/);
        if (!tu) continue;
        const cmapObj = Number(tu[1]);
        let cm = cmapCache.get(cmapObj);
        if (cm === undefined) {
          const s = streamOf(cmapObj);
          cm = s ? parseCMap(s.toString("latin1")) : null;
          cmapCache.set(cmapObj, cm);
        }
        if (cm) byName.set(name, cm);
      }
    }
  }

  // Decode a show-text operand through the active font's CMap.
  const decode = (segment: string, cm: CMap | null): string => {
    if (!cm) return pdfStrings(segment).join("");
    let out = "";
    for (const m of segment.matchAll(/<([0-9a-fA-F\s]*)>|\(((?:\\.|[^\\)])*)\)/g)) {
      if (m[1] !== undefined) {
        const hex = m[1].replace(/[^0-9a-fA-F]/g, "");
        const step = cm.width * 2;
        for (let i = 0; i + step <= hex.length; i += step) {
          const code = parseInt(hex.slice(i, i + step), 16);
          out += cm.map.get(code) ?? "";
        }
      } else {
        // Literal string with a CMap: each BYTE is a code.
        const lit = pdfLiteral(m[2] ?? "");
        for (const ch of lit) out += cm.map.get(ch.charCodeAt(0)) ?? ch;
      }
    }
    return out;
  };

  // Inflate every stream once: content streams are read for text below, and
  // the same pass finds CMaps that per-font resolution could not reach.
  const bodies: string[] = [];
  let streams = 0;
  let inflated = 0;
  {
    let at = 0;
    for (;;) {
      const s = buf.indexOf("stream", at);
      if (s < 0) break;
      const e = buf.indexOf("endstream", s);
      if (e < 0) break;
      streams++;
      let start = s + 6;
      if (buf[start] === 0x0d) start++;
      if (buf[start] === 0x0a) start++;
      const chunk = buf.subarray(start, e);
      at = e + 9;
      try {
        bodies.push(zlib.inflateSync(chunk).toString("latin1"));
        inflated++;
      } catch {
        if (!chunk.includes(0)) bodies.push(chunk.toString("latin1"));
      }
    }
  }

  // Fallback for when font dictionaries cannot be reached BY NAME — e.g. a
  // Type3-font PDF whose /Resources dict is empty, so no /F1 → object mapping
  // exists to follow.
  //
  // Merging every CMap in the document was tried and rejected: it decodes one
  // font's codes through another's table, producing the right script with the
  // wrong characters. That is plausible-looking text no language check can
  // catch — strictly worse than reporting failure. So the fallback applies
  // only when there is exactly ONE table, where collision is impossible.
  let unionCMap: CMap | null = null;
  let cmapCount = 0;
  if (!byName.size) {
    let only: CMap | null = null;
    for (const b of bodies) {
      if (!/beginbfchar|beginbfrange/.test(b)) continue;
      const cm = parseCMap(b);
      if (!cm.map.size) continue;
      cmapCount++;
      only = cm;
    }
    // Exactly one table means no other font's codes can collide with it.
    if (cmapCount === 1) unionCMap = only;
  }

  const pieces: string[] = [];
  for (const content of bodies) {
    if (!/\b(Tj|TJ)\b/.test(content)) continue;

    let active: CMap | null = unionCMap;
    let page = "";
    // One pass over both font selections and show-text operators, in order, so
    // the right CMap is applied to each run.
    const re = /\/([A-Za-z0-9.+-]+)\s+[\d.]+\s+Tf|(\[[^\]]*\]|\((?:\\.|[^\\)])*\)|<[0-9a-fA-F\s]*>)\s*(TJ|Tj)|\b(T\*|Td|TD|ET)\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content))) {
      if (m[1] !== undefined) {
        active = byName.get(m[1]) ?? active;
      } else if (m[2] !== undefined) {
        page += decode(m[2], active);
      } else {
        page += "\n";
      }
    }
    if (page.trim()) pieces.push(page);
  }

  const text = tidy(pieces.join("\n\n"));
  const fonts = byName.size || (unionCMap ? unionCMap.map.size : 0);
  if (!text) {
    return {
      kind: "document",
      text: "",
      // Said plainly rather than returning empty and letting someone assume
      // the extractor is broken: a scanned PDF genuinely has no text layer.
      note: `no text layer found in this PDF (${streams} stream(s), ${inflated} decompressed) — it is probably scanned images, which would need OCR`,
      meta: { format: "pdf", streams, inflated, textFound: false },
    };
  }
  if (!looksLikeText(text)) {
    // The decode ran but produced glyph indices, not language — almost always
    // a subset font with no /ToUnicode table. Storing this would put confident
    // gibberish into search results, which is worse than storing nothing.
    return {
      kind: "document",
      text: "",
      note: `this PDF's text could not be decoded to real characters — its glyph codes cannot be mapped back to text without ambiguity (${cmapCount || fonts} character map(s) found, none resolvable by font). The file is stored and downloadable in full; copy its text from a PDF reader if it needs to be searchable.`,
      meta: { format: "pdf", streams, inflated, fonts, cmaps: cmapCount, textFound: false, undecodable: true },
    };
  }
  return { kind: "document", text, meta: { format: "pdf", streams, inflated, fonts, textFound: true } };
}

// --------------------------------------------------------------------- images

// Dimensions straight from the header bytes — no decoding, no dependency. Worth
// having because "which screenshot was the wide one" is answerable from it, and
// because a file whose header does not parse is not the image it claims to be.
export function imageSize(buf: Buffer): { width: number; height: number; format: string } | null {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { format: "png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 6 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buf[i + 1];
      // SOF0..SOF15 carry the frame size; C4/C8/CC are tables, not frames.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { format: "jpeg", height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
    return { format: "jpeg", width: 0, height: 0 };
  }
  if (buf.length >= 30 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    const chunk = buf.toString("ascii", 12, 16);
    if (chunk === "VP8X") return { format: "webp", width: (buf.readUIntLE(24, 3) & 0xffffff) + 1, height: (buf.readUIntLE(27, 3) & 0xffffff) + 1 };
    if (chunk === "VP8 ") return { format: "webp", width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    if (chunk === "VP8L") {
      const b = buf.readUInt32LE(21);
      return { format: "webp", width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    return { format: "webp", width: 0, height: 0 };
  }
  if (buf.length >= 10 && buf.toString("ascii", 0, 3) === "GIF") {
    return { format: "gif", width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  return null;
}

// ----------------------------------------------------------------- entrypoint

export function extractFile(filename: string, buf: Buffer): Extracted {
  if (IMAGE_EXT.test(filename)) {
    const size = imageSize(buf);
    return {
      kind: "image",
      text: "",
      note: size
        ? `${size.format.toUpperCase()} image, ${size.width}×${size.height}`
        : "image (dimensions unreadable — the header does not match the extension)",
      meta: size ? { ...size, bytes: buf.length } : { bytes: buf.length },
    };
  }
  if (PDF_EXT.test(filename)) {
    const r = extractPdf(buf);
    return { ...r, text: clip(r.text) };
  }
  if (DOC_EXT.test(filename)) {
    const r = extractOoxml(filename, buf);
    return { ...r, text: clip(r.text) };
  }
  if (TEXT_EXT.test(filename)) {
    return { kind: "text", text: clip(tidy(buf.toString("utf8"))), meta: { bytes: buf.length } };
  }
  if (LEGACY_OFFICE_EXT.test(filename)) {
    return {
      kind: "binary",
      text: "",
      // A 1997 binary format needs a parser of its own, and pretending
      // otherwise would produce mojibake that looks like content.
      note: `legacy Office format (${filename.split(".").pop()}) — the file is stored, but its text cannot be read. Save it as .docx/.pptx/.xlsx and re-upload to make it searchable.`,
    };
  }
  return { kind: "binary", text: "", note: "stored as-is — no text extractor for this file type", meta: { bytes: buf.length } };
}
