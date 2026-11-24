/** Restrict uploads to formats the ingestion pipeline understands; never trust MIME alone. */
export function detectUploadType(buffer: Buffer): string | null {
  if (buffer.subarray(0, 5).toString("ascii") === "%PDF-")
    return "application/pdf";
  if (
    buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (
    buffer.length >= 3 &&
    buffer[0] === 255 &&
    buffer[1] === 216 &&
    buffer[2] === 255
  )
    return "image/jpeg";
  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  )
    return "image/webp";
  return null;
}
