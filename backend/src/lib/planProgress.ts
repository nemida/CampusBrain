/** Count each subject once per day, including multi-subject plans and partial completion. */
export function subjectPlanProgress(
  days: { subjectId: string | null; isCompleted: boolean; sessions: unknown }[],
): Map<string, { done: number; total: number }> {
  const progress = new Map<string, { done: number; total: number }>();
  for (const day of days) {
    const subjects = new Map<string, boolean[]>();
    if (Array.isArray(day.sessions)) {
      for (const session of day.sessions) {
        if (
          !session ||
          typeof session !== "object" ||
          typeof session.subjectId !== "string" ||
          !["learn", "revision", "focus"].includes(session.kind)
        )
          continue;
        subjects.set(session.subjectId, [
          ...(subjects.get(session.subjectId) ?? []),
          day.isCompleted || session.done === true,
        ]);
      }
    } else if (day.subjectId) subjects.set(day.subjectId, [day.isCompleted]);
    for (const [id, completed] of subjects) {
      const value = progress.get(id) ?? { done: 0, total: 0 };
      value.total++;
      if (completed.every(Boolean)) value.done++;
      progress.set(id, value);
    }
  }
  return progress;
}
