export const ACCEPTED_UPLOAD_TYPES = ["application/pdf", "image/png", "image/jpeg", "image/webp"];
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export function uploadError(file: { type: string; size: number }): string | null {
  if (!ACCEPTED_UPLOAD_TYPES.includes(file.type)) return "Choose a PDF, PNG, JPEG or WebP file.";
  if (file.size === 0) return "The file is empty. Choose another file.";
  if (file.size > MAX_UPLOAD_BYTES) return "File is too large. The maximum size is 25 MB.";
  return null;
}
