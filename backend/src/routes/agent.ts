/**
 * POST /api/agent/chat — streaming agentic chat endpoint.
 *
 * Sends Server-Sent Events (SSE) as the LangGraph ReAct agent works:
 *   data: {"type":"tool_call","name":"search_papers",...}
 *   data: {"type":"tool_result","name":"search_papers",...}
 *   data: {"type":"message","content":"Here's what I found..."}
 *   data: {"type":"done"}
 *
 * Requires authentication. The agent acts on behalf of the authenticated user.
 */
import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { requireStudyAccess } from "../middleware/requireAuth.js";
import { streamAgent, type ChatTurn } from "../lib/agent.js";

const router = Router();

const chatSchema = z.object({
  message: z.string().trim().min(1).max(4000),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().max(16000),
      }),
    )
    .max(20)
    .default([]),
});

router.post(
  "/chat",
  requireStudyAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = chatSchema.parse(req.body);

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no", // disable proxy buffering (Nginx etc.)
      });

      // Keep the connection alive while the agent works
      const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15_000);
      let disconnected = false;
      const controller = new AbortController();
      res.once("close", () => {
        disconnected = true;
        controller.abort();
        clearInterval(heartbeat);
      });

      try {
        await streamAgent(
          body.message,
          req.user!.id,
          body.history as ChatTurn[],
          (event) => {
            if (!disconnected) res.write(`data: ${JSON.stringify(event)}\n\n`);
          },
          controller.signal,
        );
      } finally {
        clearInterval(heartbeat);
      }

      res.end();
    } catch (err) {
      if (!res.headersSent) {
        next(err);
      } else {
        res.write(
          `data: ${JSON.stringify({ type: "error", message: "Stream error" })}\n\n`,
        );
        res.end();
      }
    }
  },
);

export default router;
