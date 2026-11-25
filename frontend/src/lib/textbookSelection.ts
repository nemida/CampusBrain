import type { ApiSubject, ApiSyllabus, ApiSyllabusItem } from "./api";

/** Enforce the visible course scope even if an older API returns a broader list. */
export function textbookSubjects(
  subjects: ApiSubject[],
  branchCode: string | undefined,
  semester: number | undefined,
): ApiSubject[] {
  if (!branchCode || !semester) return [];
  return subjects.filter(
    (subject) => subject.branchCode === branchCode && subject.semester === semester,
  );
}

export function textbookUnits(
  syllabi: ApiSyllabus[],
  subjectId: string,
  branchId: string,
  semester: number,
): ApiSyllabusItem[] {
  const matching = syllabi
    .filter((syllabus) => syllabus.branchId === branchId && syllabus.semester === semester)
    .flatMap((syllabus) =>
      syllabus.items
        .filter((unit) => unit.subjectId === subjectId)
        .map((unit) => ({ ...unit, title: `${unit.title} (${syllabus.scheme})` })),
    );
  return [...new Map(matching.map((unit) => [unit.id, unit])).values()].sort(
    (a, b) => a.unitNumber - b.unitNumber || a.title.localeCompare(b.title),
  );
}
