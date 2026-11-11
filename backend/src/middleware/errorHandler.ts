import { Request, Response, NextFunction } from "express";
import { Prisma } from "@prisma/client";
import multer from "multer";
import { ZodError } from "zod";

export interface AppError extends Error {
  statusCode?: number;
}

/** Map any thrown error to an HTTP status + client-safe message. */
function normalise(err: AppError): { status: number; message: string } {
  if (err instanceof ZodError) {
    const message = err.issues
      .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
      .join("; ");
    return { status: 400, message: message || "Invalid request" };
  }

  if (err instanceof multer.MulterError) {
    const message = err.code === "LIMIT_FILE_SIZE" ? "File is too large (max 20 MB)" : err.message;
    return { status: 400, message };
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002")
      return { status: 409, message: "A record with these details already exists" };
    if (err.code === "P2025") return { status: 404, message: "Record not found" };
    if (err.code === "P2003") return { status: 400, message: "Referenced record does not exist" };
  }

  if (err.message === "Only PDF files are allowed" || err.message.startsWith("Unknown examType")) {
    return { status: 400, message: err.message };
  }

  if (err.message.startsWith("CORS:")) {
    return { status: 403, message: err.message };
  }

  if (err instanceof SyntaxError && "body" in err) {
    return { status: 400, message: "Malformed JSON body" };
  }

  return { status: err.statusCode ?? 500, message: err.message };
}

export function errorHandler(
  err: AppError,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const { status, message } = normalise(err);

  if (status >= 500) {
    console.error("[ERROR]", err);
  }

  res.status(status).json({ error: status < 500 ? message : "Internal server error" });
}
