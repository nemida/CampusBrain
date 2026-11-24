/**
 * POST /api/auth/register  — create a new user (TEACHER/ADMIN only from existing admin)
 * POST /api/auth/login     — email + password → access + refresh tokens
 * POST /api/auth/refresh   — swap refresh token for new access token
 * POST /api/auth/logout    — revoke refresh token
 */
import { Router, Request, Response, NextFunction } from "express";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import { Role, Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from "../lib/jwt.js";
import { requireAuth } from "../middleware/requireAuth.js";

const router = Router();

// ── helpers ─────────────────────────────────────────────────────────────────

/** Parse refresh token expiry from env string like "7d" to a Date */
function refreshExpiresAt(): Date {
  const raw = process.env.JWT_REFRESH_EXPIRES_IN ?? "7d";
  const match = raw.match(/^(\d+)([smhd])$/);
  if (!match) throw new Error("Invalid JWT_REFRESH_EXPIRES_IN format");
  const [, amount, unit] = match;
  const ms: Record<string, number> = { s: 1e3, m: 6e4, h: 36e5, d: 864e5 };
  return new Date(Date.now() + Number(amount) * (ms[unit!] ?? 864e5));
}

/**
 * Persist a new refresh token. The row id is generated up front and used as the
 * JWT `jti`, so the token can be stored in a single insert (no placeholder value
 * that would collide on the unique `token` column under concurrent logins).
 */
async function issueRefreshToken(
  userId: string,
  db: Prisma.TransactionClient = prisma,
): Promise<string> {
  const id = randomUUID();
  const token = signRefreshToken({ sub: userId, jti: id });
  await db.refreshToken.create({
    data: { id, userId, token, expiresAt: refreshExpiresAt() },
  });
  return token;
}

// ── POST /api/auth/register-student ─────────────────────────────────────────
// Public endpoint — any visitor can create a STUDENT account.

const studentRegisterSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z
    .string()
    .min(8)
    .refine(
      (value) => Buffer.byteLength(value, "utf8") <= 72,
      "Password must be at most 72 UTF-8 bytes",
    ),
  name: z.string().trim().min(1).max(100),
});

router.post(
  "/register-student",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = studentRegisterSchema.parse(req.body);

      const existing = await prisma.user.findUnique({
        where: { email: body.email.toLowerCase() },
      });
      if (existing) {
        res.status(409).json({ error: "Email already registered" });
        return;
      }

      const passwordHash = await bcrypt.hash(body.password, 12);
      const user = await prisma.user.create({
        data: {
          email: body.email.toLowerCase(),
          passwordHash,
          name: body.name,
          role: Role.STUDENT,
        },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          createdAt: true,
        },
      });

      res.status(201).json({ user });
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /api/auth/register ──────────────────────────────────────────────────
// Only an existing ADMIN can create TEACHER accounts.
// For the demo seed, the first admin is created by the seed script directly.

const registerSchema = studentRegisterSchema.extend({
  role: z.nativeEnum(Role).default(Role.STUDENT),
});

router.post(
  "/register",
  requireAuth([Role.ADMIN]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = registerSchema.parse(req.body);

      const email = body.email.toLowerCase();
      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing) {
        res.status(409).json({ error: "Email already registered" });
        return;
      }

      const passwordHash = await bcrypt.hash(body.password, 12);
      const user = await prisma.user.create({
        data: { email, passwordHash, name: body.name, role: body.role },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          createdAt: true,
        },
      });

      res.status(201).json({ user });
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /api/auth/login ────────────────────────────────────────────────────

const loginSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(1024),
});

router.post(
  "/login",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = loginSchema.parse(req.body);

      const user = await prisma.user.findUnique({
        where: { email: body.email.toLowerCase() },
      });
      if (!user) {
        res.status(401).json({ error: "Invalid credentials" });
        return;
      }

      const passwordOk = await bcrypt.compare(body.password, user.passwordHash);
      if (!passwordOk) {
        res.status(401).json({ error: "Invalid credentials" });
        return;
      }

      const accessToken = signAccessToken({
        sub: user.id,
        email: user.email,
        role: user.role,
      });

      // Housekeeping: drop this user's expired refresh tokens
      await prisma.refreshToken.deleteMany({
        where: { userId: user.id, expiresAt: { lt: new Date() } },
      });

      // Persist refresh token so we can revoke it on logout
      const refreshToken = await issueRefreshToken(user.id);

      res.json({
        accessToken,
        refreshToken,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /api/auth/refresh ──────────────────────────────────────────────────

const refreshSchema = z.object({ refreshToken: z.string().min(1) });

router.post(
  "/refresh",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { refreshToken } = refreshSchema.parse(req.body);

      let payload;
      try {
        payload = verifyRefreshToken(refreshToken);
      } catch {
        res.status(401).json({ error: "Invalid or expired refresh token" });
        return;
      }

      // Verify it still exists in the DB (not revoked)
      const stored = await prisma.refreshToken.findUnique({
        where: { id: payload.jti },
      });
      if (
        !stored ||
        stored.userId !== payload.sub ||
        stored.token !== refreshToken ||
        stored.expiresAt <= new Date()
      ) {
        res.status(401).json({ error: "Refresh token revoked or expired" });
        return;
      }

      const user = await prisma.user.findUnique({ where: { id: payload.sub } });
      if (!user) {
        res.status(401).json({ error: "User not found" });
        return;
      }

      const accessToken = signAccessToken({
        sub: user.id,
        email: user.email,
        role: user.role,
      });

      // Consume exactly once. Concurrent refreshes cannot both mint a replacement,
      // and a failed insert rolls the deletion back so the session can be retried.
      const newRefreshToken = await prisma.$transaction(async (tx) => {
        const consumed = await tx.refreshToken.deleteMany({
          where: {
            id: stored.id,
            token: refreshToken,
            expiresAt: { gt: new Date() },
          },
        });
        return consumed.count === 1 ? issueRefreshToken(user.id, tx) : null;
      });
      if (!newRefreshToken) {
        res
          .status(401)
          .json({ error: "Refresh token already used or expired" });
        return;
      }

      res.json({ accessToken, refreshToken: newRefreshToken });
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /api/auth/logout ───────────────────────────────────────────────────

router.post(
  "/logout",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { refreshToken } = refreshSchema.parse(req.body);

      let payload;
      try {
        payload = verifyRefreshToken(refreshToken);
      } catch {
        // Token is already invalid — treat logout as success
        res.status(204).send();
        return;
      }

      await prisma.refreshToken.deleteMany({ where: { id: payload.jti } });
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  },
);

export default router;
