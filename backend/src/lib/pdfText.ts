/**
 * Download a PDF and extract its text. Shared by chunk ingestion and question extraction.
 * Supports pdf-parse v2 (`PDFParse` class) and v1 (default function, which also gives per-page text).
 */

// pdf-parse v2 inserts "-- 1 of 2 --" between pages. That is parser noise, not paper content.
const PAGE_MARKER =
  /\n?[ \t]*--[ \t]*\d+[ \t]*(?:of|\/)[ \t]*\d+[ \t]*--[ \t]*\n?/gi;

/** Letters/digits left after removing parser page markers. Scanned (image-only) PDFs end up near 0. */
export function usableTextLength(text: string): number {
  return text.replace(PAGE_MARKER, " ").replace(/[^\p{L}\p{N}]/gu, "").length;
}

/** False for scanned PDFs: their text layer is empty or just page markers, so there is nothing to index. */
export function hasUsableText(text: string, minChars = 150): boolean {
  return usableTextLength(text) >= minChars;
}

export interface PdfText {
  text: string;
  pages: string[]; // per-page text when the parser provides it (v1), otherwise []
}

const DOWNLOAD_TIMEOUT_MS = 60_000;
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;

/** Bound actual streamed bytes as well as declared length to protect ingestion memory. */
export async function downloadDocument(url: string): Promise<Buffer> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok)
    throw new Error(`Failed to download document: HTTP ${response.status}`);
  if (Number(response.headers.get("content-length")) > MAX_DOWNLOAD_BYTES) {
    await response.body?.cancel();
    throw new Error("Document exceeds the 25 MB download limit");
  }
  if (!response.body)
    throw new Error("Document download returned an empty body");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_DOWNLOAD_BYTES)
        throw new Error("Document exceeds the 25 MB download limit");
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export interface PdfFile extends PdfText {
  buffer: Buffer;
}

/** Download + parse. Keeps the raw bytes so scanned PDFs can be sent to a vision model. */
export async function fetchPdf(pdfUrl: string): Promise<PdfFile> {
  const buffer = await downloadDocument(pdfUrl);
  return { buffer, ...(await parsePdfBuffer(buffer)) };
}

export async function fetchPdfText(pdfUrl: string): Promise<PdfText> {
  const { text, pages } = await fetchPdf(pdfUrl);
  return { text, pages };
}

export async function parsePdfBuffer(buffer: Buffer): Promise<PdfText> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod = (await import("pdf-parse")) as any;
  const pages: string[] = [];
  let text = "";

  if (typeof mod.PDFParse === "function") {
    const parser = new mod.PDFParse({ data: new Uint8Array(buffer) });
    try {
      const result = (await parser.getText()) as {
        text?: string;
        total?: number;
        pages?: { num: number; text: string }[];
      };
      text = (result.text ?? "").replace(PAGE_MARKER, "\n");
      const byPage = new Map(
        (result.pages ?? []).map((page) => [page.num, page.text]),
      );
      for (
        let page = 1;
        page <= (result.total ?? result.pages?.length ?? 0);
        page++
      ) {
        pages.push((byPage.get(page) ?? "").replace(PAGE_MARKER, "\n"));
      }
    } finally {
      await parser.destroy?.();
    }
  } else {
    const legacy = mod.default ?? mod;
    const data = (await legacy(buffer, {
      pagerender: (pageData: {
        getTextContent: () => Promise<{ items: { str: string }[] }>;
      }) =>
        pageData.getTextContent().then((content) => {
          const t = content.items.map((i) => i.str).join(" ");
          pages.push(t);
          return t;
        }),
    })) as { text: string };
    text = data.text ?? "";
  }
  return { text, pages };
}
