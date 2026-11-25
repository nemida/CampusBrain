import { Request, Response, NextFunction } from "express";
import { Role } from "@prisma/client";
import { verifyAccessToken } from "../lib/jwt.js";
import { env } from "../lib/env.js";

/**
 * Verifies the Bearer token in Authorization header and attaches
 * req.user. Returns 401 if missing/invalid, 403 if role check fails.
 */
export function requireAuth(allowedRoles?: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      res.status(401).json({ error: "Missing or malformed Authorization header" });
      return;
    }

    const token = authHeader.slice(7);
    try {
      const payload = verifyAccessToken(token);
      req.user = { id: payload.sub, email: payload.email, role: payload.role };

      if (allowedRoles && !allowedRoles.includes(payload.role)) {
        res.status(403).json({ error: "Insufficient permissions" });
        return;
      }

      next();
    } catch {
      res.status(401).json({ error: "Invalid or expired access token" });
    }
  };
}

export const requireStudyAccess = requireAuth(
  env.STUDY_FEATURE_ACCESS === "admin" ? [Role.ADMIN] : undefined,
);
