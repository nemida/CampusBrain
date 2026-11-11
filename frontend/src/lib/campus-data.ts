/**
 * Static UI constants shared across the dashboard.
 *
 * Mock data generators have been removed — subjects and papers now come from
 * the API (see src/lib/api.ts).  Only pure constants that the filter dropdowns
 * and helper utilities need remain here.
 */

export const YEARS = ["1st Year", "2nd Year", "3rd Year", "4th Year"] as const;
export const SEMESTERS = [1, 2, 3, 4, 5, 6, 7, 8] as const;
export const BRANCHES = ["Computer Science", "Electronics", "EEE", "IT"] as const;

export const YEAR_TO_SEMESTERS: Record<string, number[]> = {
  "1st Year": [1, 2],
  "2nd Year": [3, 4],
  "3rd Year": [5, 6],
  "4th Year": [7, 8],
};

export type ExamType = "Mid-Sem" | "End-Sem";

/**
 * Frontend Paper shape — matches the API response fields the table uses.
 * `id` is the database resource ID (used for delete and bot-URL lookup).
 */
export type Paper = {
  id: string;
  subjectCode: string;
  title: string;
  year: number;
  examType: ExamType;
  size: string;
  pdfUrl: string;
};

export type Subject = {
  id?: string; // present when data comes from the API
  code: string;
  name: string;
  semester: number;
  branch: string;
  paperCount?: number;
};
