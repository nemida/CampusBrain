/**
 * Seed script — run with:  npm run db:seed
 *
 * Subjects are generated automatically by scanning the OUTPUT/ folder.
 * Structure: OUTPUT/<BRANCH_FOLDER>/<SEMX>/<Subject_Name>.pdf
 *
 * Safe to re-run: everything is upserted, existing data is never deleted.
 */

import * as path from "path";
import * as fs from "fs";
import * as url from "url";
import * as dotenv from "dotenv";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

import { PrismaClient, Role } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

// ── Config ────────────────────────────────────────────────────────────────────

const OUTPUT_DIR = path.resolve(__dirname, "../../OUTPUT");

// Map OUTPUT folder names → branch { name, code }
const BRANCH_FOLDER_MAP: Record<string, { name: string; code: string }> = {
  CSE: { name: "Computer Science", code: "CS" },
  ECE: { name: "Electronics", code: "EC" },
  EEE: { name: "EEE", code: "EE" },
  IT: { name: "IT", code: "IT" },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function filenameToPretty(filename: string): string {
  return filename.replace(/\.pdf$/i, "").replace(/_/g, " ");
}

/** Scan OUTPUT/ and return a flat list of subjects */
function scanSubjects(): { name: string; branchCode: string; semester: number }[] {
  const subjects: { name: string; branchCode: string; semester: number }[] = [];
  const seen = new Set<string>(); // deduplicate name+branchCode+semester

  if (!fs.existsSync(OUTPUT_DIR)) {
    console.warn(`⚠️   ${OUTPUT_DIR} not found — no subjects will be seeded`);
    return subjects;
  }

  for (const branchFolder of fs.readdirSync(OUTPUT_DIR)) {
    const branchPath = path.join(OUTPUT_DIR, branchFolder);
    if (!fs.statSync(branchPath).isDirectory()) continue;

    const branch = BRANCH_FOLDER_MAP[branchFolder.toUpperCase()];
    if (!branch) continue;

    for (const semFolder of fs.readdirSync(branchPath)) {
      const semPath = path.join(branchPath, semFolder);
      if (!fs.statSync(semPath).isDirectory()) continue;

      const semMatch = semFolder.match(/(\d+)/);
      if (!semMatch) continue;
      const semester = parseInt(semMatch[1]!, 10);

      for (const file of fs.readdirSync(semPath)) {
        if (!file.toLowerCase().endsWith(".pdf")) continue;
        const name = filenameToPretty(file);
        const key = `${branch.code}|${semester}|${name}`;
        if (!seen.has(key)) {
          seen.add(key);
          subjects.push({ name, branchCode: branch.code, semester });
        }
      }
    }
  }

  return subjects;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("🌱  Seeding CampusBrain database…\n");

  // ── Users ─────────────────────────────────────────────────────────────────
  const adminHash = await bcrypt.hash("admin", 12);
  const admin = await prisma.user.upsert({
    where: { email: "admin@campusbrain.edu" },
    update: {},
    create: {
      email: "admin@campusbrain.edu",
      passwordHash: adminHash,
      name: "Admin",
      role: Role.ADMIN,
    },
  });
  console.log(`✅  Admin user:   ${admin.email}`);

  const teacherHash = await bcrypt.hash("teacher123", 12);
  await prisma.user.upsert({
    where: { email: "teacher@campusbrain.edu" },
    update: {},
    create: {
      email: "teacher@campusbrain.edu",
      passwordHash: teacherHash,
      name: "Demo Teacher",
      role: Role.TEACHER,
    },
  });
  console.log(`✅  Teacher user: teacher@campusbrain.edu`);

  // ── Branches ──────────────────────────────────────────────────────────────
  const branchMap: Record<string, string> = {}; // code → id
  const branches = Object.values(BRANCH_FOLDER_MAP);

  for (const b of branches) {
    const branch = await prisma.branch.upsert({
      where: { code: b.code },
      update: { name: b.name },
      create: b,
    });
    branchMap[b.code] = branch.id;
  }
  console.log(`✅  ${branches.length} branches seeded`);

  // ── Subjects (scanned from OUTPUT/) ───────────────────────────────────────
  const subjects = scanSubjects();
  let subjectCount = 0;

  for (const s of subjects) {
    const branchId = branchMap[s.branchCode];
    if (!branchId) continue;

    // Use name as code since we don't have real codes
    const code = s.name.replace(/\s+/g, "_").toUpperCase().slice(0, 50);

    await prisma.subject.upsert({
      where: { code_branchId: { code, branchId } },
      update: { name: s.name, semester: s.semester },
      create: { code, name: s.name, semester: s.semester, branchId },
    });
    subjectCount++;
  }
  console.log(`✅  ${subjectCount} subjects seeded from OUTPUT/`);

  console.log("\n🎉  Seed complete!");
  console.log("    Admin login:   admin@campusbrain.edu  /  admin");
  console.log("    Teacher login: teacher@campusbrain.edu  /  teacher123");
}

main()
  .catch((e) => {
    console.error("❌  Seed failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
