/**
 * GET /api/bot/url?resourceId=<id>
 *
 * Builds and returns the full Streamlit handoff URL for a given resource.
 * The frontend calls this instead of constructing the URL itself, so the
 * Streamlit query-param contract lives in exactly one place: the backend.
 *
 * Response:
 *   { url: "https://your-streamlit-app.streamlit.app/?paperId=...&pdfUrl=...&..." }
 *
 * GET /api/bot/url  (no resourceId)
 *   Returns the bare BOT_BASE_URL — used by the "Ask AI Assistant" header button.
 */
import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { env } from "../lib/env.js";

const router = Router();

const querySchema = z.object({
  resourceId: z.string().optional(),
});

router.get("/url", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { resourceId } = querySchema.parse(req.query);

    // No resourceId → bare bot URL (header "Ask AI Assistant" button)
    if (!resourceId) {
      res.json({ url: env.BOT_BASE_URL });
      return;
    }

    const resource = await prisma.resource.findUnique({
      where: { id: resourceId },
      include: {
        subject: {
          include: { branch: { select: { code: true, name: true } } },
        },
      },
    });

    if (!resource) {
      res.status(404).json({ error: "Resource not found" });
      return;
    }

    // paperId format matches the original frontend convention: "<subjectCode>_<year>"
    const paperId = `${resource.subject.code}_${resource.year}`;

    // subject param: strip non-alphanumeric (matches buildBotUrl in campus-data.ts)
    const subjectParam = resource.subject.name.replace(/[^a-zA-Z0-9]/g, "");

    const params = new URLSearchParams({
      paperId,
      pdfUrl: resource.fileUrl,
      subject: subjectParam,
      semester: String(resource.subject.semester),
      year: String(resource.year),
      branch: resource.subject.branch.code, // e.g. "CS", "IT"
    });

    res.json({ url: `${env.BOT_BASE_URL}?${params.toString()}` });
  } catch (err) {
    next(err);
  }
});

export default router;
