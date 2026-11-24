import jwt from "jsonwebtoken";
import { Role } from "@prisma/client";
import { env } from "./env.js";
import { z } from "zod";

const accessClaims = z.object({
  sub: z.string().min(1),
  email: z.string().email(),
  role: z.nativeEnum(Role),
});
const refreshClaims = z.object({
  sub: z.string().min(1),
  jti: z.string().min(1),
});

export interface AccessTokenPayload {
  sub: string; // user.id
  email: string;
  role: Role;
}

export interface RefreshTokenPayload {
  sub: string; // user.id
  jti: string; // RefreshToken.id — lets us revoke individual tokens
}

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_EXPIRES_IN as jwt.SignOptions["expiresIn"],
  });
}

export function signRefreshToken(payload: RefreshTokenPayload): string {
  return jwt.sign(payload, env.JWT_REFRESH_SECRET, {
    expiresIn: env.JWT_REFRESH_EXPIRES_IN as jwt.SignOptions["expiresIn"],
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return accessClaims.parse(
    jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ["HS256"] }),
  );
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  return refreshClaims.parse(
    jwt.verify(token, env.JWT_REFRESH_SECRET, { algorithms: ["HS256"] }),
  );
}
