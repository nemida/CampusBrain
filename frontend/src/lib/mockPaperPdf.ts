/**
 * Minimal, dependency-free PDF writer for the AI coach's mock papers (text only, A4, standard Helvetica).
 * Non-Latin-1 characters are transliterated or replaced with "?" because the standard fonts only cover Latin-1.
 */
import type { ApiMockPaper } from "@/lib/api";

const PAGE_W = 595;
const PAGE_H = 842;
const MARGIN = 56;
const CONTENT_W = PAGE_W - MARGIN * 2;

// Helvetica glyph widths (1/1000 em) for ASCII 32..126
const W = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667,
  611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
  667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500,
  222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

const REPLACEMENTS: [RegExp, string][] = [
  [/[\u2018\u2019\u201B]/g, "'"],
  [/[\u201C\u201D\u201F]/g, '"'],
  [/[\u2013\u2014\u2212]/g, "-"],
  [/\u2026/g, "..."],
  [/\u2264/g, "<="],
  [/\u2265/g, ">="],
  [/\u2260/g, "!="],
  [/\u2192/g, "->"],
  [/\u2190/g, "<-"],
  [/[\u2022\u25CF]/g, "-"],
  [/\u00A0/g, " "],
  [/\t/g, "    "],
];

function clean(s: string): string {
  let out = s;
  for (const [re, rep] of REPLACEMENTS) out = out.replace(re, rep);
  let res = "";
  for (const ch of out) {
    const c = ch.codePointAt(0)!;
    if (c === 10) res += " ";
    else if (c >= 32 && c < 127) res += ch;
    else if (c >= 161 && c <= 255) res += ch;
    else res += "?";
  }
  return res;
}

function width(text: string, size: number, bold = false): number {
  let w = 0;
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    w += c >= 32 && c <= 126 ? W[c - 32]! : 556;
  }
  return ((w * size) / 1000) * (bold ? 1.06 : 1);
}

function wrap(text: string, size: number, maxW: number, bold = false): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of clean(text).split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (width(next, size, bold) <= maxW) {
      line = next;
      continue;
    }
    if (line) lines.push(line);
    // a single over-long word: hard-split it
    let rest = word;
    while (width(rest, size, bold) > maxW && rest.length > 1) {
      let n = rest.length - 1;
      while (n > 1 && width(rest.slice(0, n), size, bold) > maxW) n--;
      lines.push(rest.slice(0, n));
      rest = rest.slice(n);
    }
    line = rest;
  }
  if (line) lines.push(line);
  return lines;
}

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

class Doc {
  private pages: string[] = [];
  private ops: string[] = [];
  y = PAGE_H - MARGIN;

  constructor() {
    this.newPage(false);
  }

  newPage(flush = true) {
    if (flush) this.pages.push(this.ops.join("\n"));
    this.ops = [];
    this.y = PAGE_H - MARGIN;
  }

  /** Make sure `h` points of vertical space remain, else start a new page. */
  ensure(h: number) {
    if (this.y - h < MARGIN) this.newPage();
  }

  text(s: string, x: number, size: number, bold = false) {
    this.ops.push(
      `BT /${bold ? "F2" : "F1"} ${size} Tf ${x.toFixed(2)} ${this.y.toFixed(2)} Td (${esc(clean(s))}) Tj ET`,
    );
  }

  rule(gray = 0.6) {
    this.ops.push(
      `${gray} G 0.6 w ${MARGIN} ${this.y.toFixed(2)} m ${PAGE_W - MARGIN} ${this.y.toFixed(2)} l S 0 G`,
    );
  }

  finish(): Blob {
    this.pages.push(this.ops.join("\n"));
    const objs: string[] = [];
    const add = (body: string) => {
      objs.push(body);
      return objs.length;
    };
    const catalog = add("");
    const pagesObj = add("");
    const f1 = add(
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    );
    const f2 = add(
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
    );
    const kids: number[] = [];
    this.pages.forEach((content, i) => {
      const footer = `BT /F1 8 Tf ${PAGE_W / 2 - 20} 30 Td (Page ${i + 1} of ${this.pages.length}) Tj ET`;
      const stream = `${content}\n${footer}`;
      const c = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
      kids.push(
        add(
          `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${c} 0 R >>`,
        ),
      );
    });
    objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
    objs[pagesObj - 1] =
      `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;

    let out = "%PDF-1.4\n";
    const offsets: number[] = [];
    objs.forEach((body, i) => {
      offsets.push(out.length);
      out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xref = out.length;
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
    out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF`;

    // every character is <= 255 (see clean()), so a byte-per-char encoding keeps offsets exact
    const bytes = new Uint8Array(out.length);
    for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
    return new Blob([bytes], { type: "application/pdf" });
  }
}

const ORIGIN_LABEL = { pyq: "Past paper", variant: "Variant", new: "New" } as const;

export function buildMockPaperPdf(paper: ApiMockPaper, opts: { includeMap?: boolean } = {}): Blob {
  const doc = new Doc();
  const centre = (s: string, size: number, bold: boolean) => {
    const x = Math.max(MARGIN, (PAGE_W - width(clean(s), size, bold)) / 2);
    doc.text(s, x, size, bold);
  };

  // ── Header ──
  for (const line of wrap(paper.title, 16, CONTENT_W, true)) {
    centre(line, 16, true);
    doc.y -= 20;
  }
  centre(`${paper.subjectCode} - ${paper.subjectName}`, 10, false);
  doc.y -= 18;
  doc.text(`Time: ${paper.durationMinutes} minutes`, MARGIN, 10, true);
  const marksText = `Maximum marks: ${paper.totalMarks}`;
  doc.text(marksText, PAGE_W - MARGIN - width(marksText, 10, true), 10, true);
  doc.y -= 8;
  doc.rule(0);
  doc.y -= 16;

  doc.text("Instructions", MARGIN, 9, true);
  doc.y -= 13;
  for (const ins of paper.instructions) {
    for (const [i, l] of wrap(ins, 9, CONTENT_W - 14).entries()) {
      doc.text(i === 0 ? `-  ${l}` : l, MARGIN + (i === 0 ? 0 : 14), 9);
      doc.y -= 12;
    }
  }
  doc.y -= 6;

  // ── Sections ──
  const QX = MARGIN + 28; // question text column
  const TEXT_W = CONTENT_W - 28 - 36;
  for (const sec of paper.sections) {
    doc.ensure(60);
    doc.y -= 6;
    doc.rule(0.75);
    doc.y -= 15;
    doc.text(sec.name, MARGIN, 11, true);
    doc.y -= 14;
    for (const l of wrap(sec.instructions, 9, CONTENT_W)) {
      doc.text(l, MARGIN, 9);
      doc.y -= 12;
    }
    doc.y -= 6;

    for (const q of sec.questions) {
      const lines = wrap(q.text, 10.5, TEXT_W);
      doc.ensure(Math.min(lines.length, 3) * 14 + 8);
      doc.text(`Q${q.no}.`, MARGIN, 10.5, true);
      const mk = `[${q.marks}]`;
      doc.text(mk, PAGE_W - MARGIN - width(mk, 10.5, true), 10.5, true);
      for (const l of lines) {
        doc.ensure(14);
        doc.text(l, QX, 10.5);
        doc.y -= 14;
      }
      doc.y -= 8;
    }
  }

  doc.y -= 6;
  doc.ensure(24);
  centre("*** End of paper ***", 9, false);

  // ── Paper map (sources + coverage), on its own page so the exam pages stay clean ──
  if (opts.includeMap !== false) {
    doc.newPage();
    doc.text("Paper map (for the student - not part of the exam)", MARGIN, 12, true);
    doc.y -= 20;
    doc.text("Syllabus coverage", MARGIN, 10, true);
    doc.y -= 14;
    for (const c of paper.coverage) {
      for (const [i, l] of wrap(
        `${c.unit}: ${c.questions} question(s), ${c.marks} marks`,
        9.5,
        CONTENT_W - 10,
      ).entries()) {
        doc.ensure(13);
        doc.text(l, MARGIN + (i === 0 ? 0 : 10), 9.5);
        doc.y -= 13;
      }
    }
    doc.y -= 10;
    doc.ensure(30);
    doc.text("Question sources", MARGIN, 10, true);
    doc.y -= 14;
    for (const sec of paper.sections) {
      for (const q of sec.questions) {
        const src =
          q.origin === "new"
            ? "AI-written from the syllabus"
            : q.origin === "variant"
              ? `Variant of ${q.source ?? "a past question"}`
              : `Past paper: ${q.source ?? "unknown"}`;
        for (const [i, l] of wrap(
          `Q${q.no} [${ORIGIN_LABEL[q.origin]}] ${q.topic} - ${src}`,
          9,
          CONTENT_W - 10,
        ).entries()) {
          doc.ensure(12);
          doc.text(l, MARGIN + (i === 0 ? 0 : 10), 9);
          doc.y -= 12;
        }
      }
    }
    doc.y -= 8;
    doc.ensure(14);
    for (const l of wrap(`Generated by CampusBrain on ${paper.generatedOn}.`, 8, CONTENT_W)) {
      doc.text(l, MARGIN, 8);
      doc.y -= 11;
    }
  }

  return doc.finish();
}

export function downloadMockPaperPdf(paper: ApiMockPaper) {
  const blob = buildMockPaperPdf(paper);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${paper.subjectCode}-mock-paper.pdf`.replace(/[^\w.-]+/g, "_");
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
