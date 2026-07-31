import { describe, it, expect } from "vitest";
import zlib from "node:zlib";
import { extractFile, imageSize } from "./extract";

// Build a real ZIP so the OOXML reader is exercised against an actual archive
// rather than a mock of one.
function zip(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const comp = zlib.deflateRawSync(e.data);
    const name = Buffer.from(e.name, "utf8");
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += lh.length + name.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const pdfOf = (content: string, extraObjs: string[] = []) => {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ...extraObjs,
  ];
  let pdf = "%PDF-1.4\n";
  objs.forEach((o, i) => (pdf += `${i + 1} 0 obj\n${o}\nendobj\n`));
  return Buffer.from(pdf + "trailer\n<< /Root 1 0 R >>\n%%EOF", "latin1");
};

describe("documents become searchable text", () => {
  it("reads a docx body, decoding entities and keeping paragraphs", () => {
    const docx = zip([
      {
        name: "word/document.xml",
        data: Buffer.from(
          `<w:document><w:body><w:p><w:r><w:t>Quarterly review</w:t></w:r></w:p><w:p><w:r><w:t>Revenue rose 12% &amp; costs fell.</w:t></w:r></w:p></w:body></w:document>`,
        ),
      },
    ]);
    const r = extractFile("report.docx", docx);
    expect(r.kind).toBe("document");
    expect(r.text).toBe("Quarterly review\nRevenue rose 12% & costs fell.");
  });

  it("reads a pptx slide by slide, in numeric order", () => {
    // Deliberately out of order and double-digit, because "slide10" sorts
    // before "slide2" as a string and a deck would come back scrambled.
    const pptx = zip([
      { name: "ppt/slides/slide10.xml", data: Buffer.from(`<a:p><a:t>Tenth</a:t></a:p>`) },
      { name: "ppt/slides/slide2.xml", data: Buffer.from(`<a:p><a:t>Second</a:t></a:p>`) },
      { name: "ppt/slides/slide1.xml", data: Buffer.from(`<a:p><a:t>First</a:t></a:p>`) },
    ]);
    const r = extractFile("deck.pptx", pptx);
    expect(r.text.indexOf("First")).toBeLessThan(r.text.indexOf("Second"));
    expect(r.text.indexOf("Second")).toBeLessThan(r.text.indexOf("Tenth"));
    expect((r.meta as { slides: number }).slides).toBe(3);
  });

  it("says so plainly when a file is not a readable archive", () => {
    const r = extractFile("broken.docx", Buffer.from("this is not a zip at all"));
    expect(r.kind).toBe("binary");
    expect(r.note).toMatch(/no ZIP directory/);
  });

  it("extracts PDF text drawn with a standard font", () => {
    const r = extractFile("report.pdf", pdfOf(`BT /F1 12 Tf (Revenue rose 12 percent.) Tj T* (Costs fell.) Tj ET`));
    expect(r.text).toContain("Revenue rose 12 percent.");
    expect(r.text).toContain("Costs fell.");
  });

  it("reports a scanned PDF instead of returning silence", () => {
    // Content stream with no text operators at all — an image-only page.
    const r = extractFile("scan.pdf", pdfOf(`q 612 0 0 792 0 0 cm /Im1 Do Q`));
    expect(r.text).toBe("");
    expect(r.note).toMatch(/no text layer/);
    expect((r.meta as { textFound: boolean }).textFound).toBe(false);
  });

  it("REFUSES to return glyph indices as if they were text", () => {
    // A subset font's codes with no resolvable /ToUnicode: decoding them
    // literally yields "!,0++.-*(" — printable, plausible-looking, and wrong.
    // Storing that would put confident gibberish into search results, so the
    // extractor must report failure instead. This is the single most important
    // behaviour in this file: a real PDF produced exactly this.
    const r = extractFile("subset.pdf", pdfOf(`BT /F1 12 Tf (!,0++.-*&*/'%#$0+.-,) Tj ET`));
    expect(r.text).toBe("");
    expect(r.note).toMatch(/could not be decoded/);
    expect((r.meta as { undecodable?: boolean }).undecodable).toBe(true);
  });

  it("decodes a PDF through its ToUnicode CMap when one font maps the codes", () => {
    // Codes 01,02,03 mean H,i,! — meaningless without the table, correct with it.
    const cmap = `/CIDInit /ProcSet findresource begin
1 beginbfchar <01> <0048> endbfchar
1 beginbfchar <02> <0069> endbfchar
1 beginbfchar <03> <0021> endbfchar
end`;
    const pdf = pdfOf(`BT /F1 12 Tf <010203> Tj ET`, [`<< /Length ${cmap.length} >>\nstream\n${cmap}\nendstream`]);
    const r = extractFile("mapped.pdf", pdf);
    expect(r.text).toBe("Hi!");
  });
});

describe("images", () => {
  const png = () => {
    const b = Buffer.alloc(30);
    b.writeUInt32BE(0x89504e47, 0);
    b.writeUInt32BE(800, 16);
    b.writeUInt32BE(600, 20);
    return b;
  };

  it("reads PNG dimensions from the header", () => {
    expect(imageSize(png())).toEqual({ format: "png", width: 800, height: 600 });
    const r = extractFile("shot.png", png());
    expect(r.kind).toBe("image");
    expect(r.note).toBe("PNG image, 800×600");
  });

  it("reads GIF dimensions (little-endian, unlike PNG)", () => {
    const b = Buffer.alloc(12);
    b.write("GIF89a", 0, "ascii");
    b.writeUInt16LE(320, 6);
    b.writeUInt16LE(240, 8);
    expect(imageSize(b)).toEqual({ format: "gif", width: 320, height: 240 });
  });

  it("says the header does not match rather than inventing dimensions", () => {
    const r = extractFile("fake.png", Buffer.from("not really a png"));
    expect(r.kind).toBe("image");
    expect(r.note).toMatch(/dimensions unreadable/);
  });
});

describe("plain text and unsupported formats", () => {
  it("normalises whitespace without destroying paragraphs", () => {
    const r = extractFile("notes.md", Buffer.from("# Title\r\n\r\nSome  text.\n\n\n\nMore."));
    expect(r.kind).toBe("text");
    expect(r.text).toBe("# Title\n\nSome text.\n\nMore.");
  });

  it("tells you what to do about a legacy Office file instead of failing quietly", () => {
    const r = extractFile("old.doc", Buffer.from([0xd0, 0xcf, 0x11, 0xe0]));
    expect(r.kind).toBe("binary");
    expect(r.note).toMatch(/Save it as \.docx/);
  });

  it("stores an unknown type without pretending to have read it", () => {
    const r = extractFile("firmware.bin", Buffer.from([1, 2, 3]));
    expect(r.text).toBe("");
    expect(r.note).toMatch(/no text extractor/);
  });
});
