import { v2 as cloudinary, type UploadApiResponse } from "cloudinary";
import { env } from "./env.js";

cloudinary.config({
  cloud_name: env.CLOUDINARY_CLOUD_NAME,
  api_key: env.CLOUDINARY_API_KEY,
  api_secret: env.CLOUDINARY_API_SECRET,
  secure: true,
});

export interface UploadResult {
  /** Stable public ID used to delete/transform the asset later */
  publicId: string;
  /** HTTPS URL the Streamlit app (and students) can fetch directly */
  secureUrl: string;
  /** File size in bytes reported by Cloudinary */
  bytes: number;
}

/**
 * Upload a Buffer (from multer memoryStorage) to Cloudinary.
 *
 * Files land in the `campusbrain/papers` folder, tagged with the
 * subjectCode so you can bulk-manage by subject in the Cloudinary console.
 *
 * @param buffer     Raw file bytes
 * @param filename   Original filename (used as the public_id display name)
 * @param subjectCode e.g. "CS501" — used for folder organisation + tagging
 * @param mimeType   MIME type from multer (e.g. "application/pdf", "image/png")
 */
export async function uploadFile(
  buffer: Buffer,
  filename: string,
  subjectCode: string,
  mimeType: string,
): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    // Strip extension and sanitise for use as public_id
    const baseName = filename.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9_-]/g, "_");
    const publicId = `campusbrain/papers/${subjectCode}/${baseName}_${Date.now()}`;

    const isImage = mimeType.startsWith("image/");

    const uploadStream = cloudinary.uploader.upload_stream(
      {
        public_id: publicId,
        // Images go through the image pipeline; PDFs and everything else use "raw"
        resource_type: isImage ? "image" : "raw",
        // Only force the format for PDFs — let Cloudinary auto-detect image formats
        ...(isImage ? {} : { format: "pdf" }),
        tags: ["campusbrain", "pyq", subjectCode.toLowerCase()],
        // Allow any student with the URL to download — no signed URLs needed
        type: "upload",
        access_mode: "public",
      },
      (error, result?: UploadApiResponse) => {
        if (error || !result) {
          reject(error ?? new Error("Cloudinary upload returned no result"));
          return;
        }
        resolve({
          publicId: result.public_id,
          secureUrl: result.secure_url,
          bytes: result.bytes,
        });
      },
    );

    uploadStream.end(buffer);
  });
}

/**
 * Delete a previously uploaded file by its Cloudinary public_id.
 * Called when an admin deletes a paper row. The resource_type must match
 * what was used at upload time (image vs raw), so we detect it from the URL.
 */
export async function deleteFile(publicId: string, fileUrl?: string): Promise<void> {
  const resourceType = fileUrl && /\.(png|jpe?g|webp|gif)$/i.test(fileUrl) ? "image" : "raw";
  await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
}
