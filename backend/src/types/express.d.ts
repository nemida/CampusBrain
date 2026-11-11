import { Role } from "@prisma/client";

declare global {
  namespace Express {
    interface Request {
      /** Set by requireAuth middleware after JWT verification */
      user?: {
        id: string;
        email: string;
        role: Role;
      };
    }
  }
}
