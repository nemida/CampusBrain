/**
 * Bulk upload script — walks OUTPUT/ folder and uploads each PDF to
 * Cloudinary + inserts a Resource row in the DB.
 *
 * Folder structure expected:
 *   OUTPUT/<BRANCH>/<SEMX>/<Subject_Name>.pdf
 *
 * Run from backend/ folder:
 *   npx tsx scripts/bulkUpload.ts
 *
 * Defaults used when info is missing from filename:
 *   year     → 2024
 *   examType → END_SEM
 */

import * as path from "path";
import * as fs from "fs";
import * as url from "url";
import * as dotenv from "dotenv";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

import { PrismaClient, ExamType } from "@prisma/client";
import { v2 as cloudinary } from "cloudinary";

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

// ── Config ────────────────────────────────────────────────────────────────────

const OUTPUT_DIR = path.resolve(__dirname, "../../OUTPUT");
const DEFAULT_YEAR = 2024;
const DEFAULT_EXAM_TYPE = ExamType.END_SEM;

// Map folder names → DB branch names
const BRANCH_MAP: Record<string, string> = {
  CSE: "Computer Science",
  ECE: "Electronics",
  EEE: "EEE",
  IT: "IT",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Convert "Applied_Mathematics_I" → "Applied Mathematics I" */
function filenameToPretty(filename: string): string {
  return filename.replace(/_/g, " ").replace(/\.pdf$/i, "");
}

/** Match subject by name → code derived the same way as seed */
async function findSubject(prettyName: string, branchName: string, semester: number) {
  const code = prettyName.replace(/\s+/g, "_").toUpperCase().slice(0, 50);
  const branch = await prisma.branch.findFirst({ where: { name: branchName } });
  if (!branch) return null;
  return prisma.subject.findFirst({
    where: { code, branchId: branch.id, semester },
    include: { branch: true },
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("🚀  Starting bulk upload…\n");

  // Get admin user to attribute uploads to
  const admin = await prisma.user.findFirst({ where: { role: "ADMIN" } });
  if (!admin) throw new Error("No admin user found. Run db:seed first.");

  let uploaded = 0;
  let skipped = 0;
  let failed = 0;

  const branchDirs = fs.readdirSync(OUTPUT_DIR);

  for (const branchDir of branchDirs) {
    const branchPath = path.join(OUTPUT_DIR, branchDir);
    if (!fs.statSync(branchPath).isDirectory()) continue;

    const branchName = BRANCH_MAP[branchDir.toUpperCase()];
    if (!branchName) {
      console.warn(`⚠️  Unknown branch folder: ${branchDir} — skipping`);
      continue;
    }

    const semDirs = fs.readdirSync(branchPath);

    for (const semDir of semDirs) {
      const semPath = path.join(branchPath, semDir);
      if (!fs.statSync(semPath).isDirectory()) continue;

      // Parse semester number from "SEM1", "SEM2", etc.
      const semMatch = semDir.match(/(\d+)/);
      if (!semMatch) {
        console.warn(`⚠️  Cannot parse semester from: ${semDir} — skipping`);
        continue;
      }
      const semester = parseInt(semMatch[1]!, 10);

      const files = fs.readdirSync(semPath);

      for (const file of files) {
        if (!file.toLowerCase().endsWith(".pdf")) continue;

        const filePath = path.join(semPath, file);
        const prettyName = filenameToPretty(file);

        // Find matching subject in DB
        const subject = await findSubject(prettyName, branchName, semester);
        if (!subject) {
          console.warn(
            `  ⚠️  No subject match for "${prettyName}" (${branchName} Sem ${semester}) — skipping`,
          );
          skipped++;
          continue;
        }

        // Check if already uploaded (avoid duplicates)
        const existing = await prisma.resource.findFirst({
          where: {
            subjectId: subject.id,
            year: DEFAULT_YEAR,
            examType: DEFAULT_EXAM_TYPE,
          },
        });
        if (existing) {
          console.log(`  ⏭️  Already uploaded: ${prettyName} (${branchName} Sem ${semester})`);
          skipped++;
          continue;
        }

        try {
          // Upload to Cloudinary
          const buffer = fs.readFileSync(filePath);
          const subjectCode = subject.code;
          const publicId = `campusbrain/papers/${subjectCode}/${subjectCode}_${DEFAULT_YEAR}_END.pdf`;

          const uploadResult = await new Promise<{
            secure_url: string;
            public_id: string;
            bytes: number;
          }>((resolve, reject) => {
            const stream = cloudinary.uploader.upload_stream(
              {
                resource_type: "raw",
                public_id: publicId,
                access_mode: "public",
              },
              (err, result) => {
                if (err || !result) return reject(err ?? new Error("No result"));
                resolve({
                  secure_url: result.secure_url,
                  public_id: result.public_id,
                  bytes: result.bytes,
                });
              },
            );
            stream.end(buffer);
          });

          // Insert resource row
          await prisma.resource.create({
            data: {
              subjectId: subject.id,
              uploadedById: admin.id,
              title: `${DEFAULT_YEAR} End-Sem Exam`,
              year: DEFAULT_YEAR,
              examType: DEFAULT_EXAM_TYPE,
              fileUrl: uploadResult.secure_url,
              publicId: uploadResult.public_id,
              fileSizeBytes: uploadResult.bytes,
            },
          });

          console.log(
            `  ✅  ${branchDir}/SEM${semester}/${file} → ${subject.code} - ${subject.name}`,
          );
          uploaded++;
        } catch (err) {
          console.error(`  ❌  Failed: ${file} —`, err);
          failed++;
        }
      }
    }
  }

  console.log(`\n🎉  Done! Uploaded: ${uploaded} | Skipped: ${skipped} | Failed: ${failed}`);
}

main()
  .catch((e) => {
    console.error("❌  Fatal error:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
