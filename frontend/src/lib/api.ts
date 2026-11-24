/**
 * frontend/src/lib/api.ts
 * Typed API client for the CampusBrain backend.
 *
 * All requests go through `apiFetch`, which:
 *  - prefixes the configured VITE_API_URL base
 *  - attaches the Authorization: Bearer <accessToken> header when a token is stored
 *  - throws an ApiError (with status + message) for non-2xx responses
 *
 * Response types mirror the backend's JSON shapes exactly.
 */

// ── Base URL ─────────────────────────────────────────────────────────────────

import { readJsonEventStream } from "./sse";
import { RequestPool } from "./requestPool";

const BASE = (
  (import.meta.env["VITE_API_URL"] as string | undefined) || "http://localhost:4000"
).replace(/\/+$/, "");

// ── Token storage (in-memory + localStorage) ─────────────────────────────────

const TOKEN_KEY = "cb_access_token";
const REFRESH_KEY = "cb_refresh_token";

export function getAccessToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}
export function getRefreshToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(REFRESH_KEY);
}
export function storeTokens(access: string, refresh: string): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(TOKEN_KEY, access);
  localStorage.setItem(REFRESH_KEY, refresh);
}
export function clearTokens(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_KEY);
  localStorage.removeItem(USER_KEY);
}

const USER_KEY = "cb_user";

export function storeUser(user: AuthUser): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}
export function getStoredUser(): AuthUser | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as AuthUser) : null;
  } catch {
    return null;
  }
}

/** Called when a refresh attempt fails so the auth store can log the user out. */
let authLostHandler: (() => void) | null = null;
export function setAuthLostHandler(fn: (() => void) | null): void {
  authLostHandler = fn;
}

/** Single-flight token refresh — concurrent 401s share one request. */
let refreshInFlight: Promise<boolean> | null = null;

function refreshAccessToken(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;

  const refreshToken = getRefreshToken();
  if (!refreshToken) return Promise.resolve(false);

  refreshInFlight = (async () => {
    try {
      const res = await fetch(`${BASE}/api/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });
      if (!res.ok) {
        // Only a definitive rejection should end the session, not a 5xx / rate limit
        if ((res.status === 401 || res.status === 403) && getRefreshToken() === refreshToken) {
          clearTokens();
          authLostHandler?.();
        }
        return false;
      }
      const data = (await res.json()) as { accessToken: string; refreshToken: string };
      // Logout or a newer login may have happened while this request was in flight.
      if (getRefreshToken() !== refreshToken) return false;
      storeTokens(data.accessToken, data.refreshToken);
      return true;
    } catch {
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

// ── Error type ────────────────────────────────────────────────────────────────

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// ── Core fetch helper ─────────────────────────────────────────────────────────

const reads = new RequestPool();
let readGeneration = 0;

async function apiFetch<T>(path: string, init: RequestInit = {}, skipAuth = false): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  if (method !== "GET") {
    readGeneration++;
    try {
      return await performApiFetch<T>(path, init, skipAuth);
    } finally {
      readGeneration++;
    }
  }
  if (init.signal || init.headers || init.body) return performApiFetch<T>(path, init, skipAuth);
  const key = JSON.stringify([path, skipAuth ? null : getAccessToken(), readGeneration]);
  const result = await reads.run(key, () => performApiFetch<T>(path, init, skipAuth));
  return structuredClone(result);
}

async function performApiFetch<T>(
  path: string,
  init: RequestInit = {},
  skipAuth = false,
): Promise<T> {
  const headers = new Headers(init.headers);

  if (!skipAuth) {
    const token = getAccessToken();
    if (token) headers.set("Authorization", `Bearer ${token}`);
  }

  // Don't set Content-Type for FormData — let the browser set it with boundary
  if (!(init.body instanceof FormData) && !headers.has("Content-Type") && init.body) {
    headers.set("Content-Type", "application/json");
  }

  let res = await fetch(`${BASE}${path}`, { ...init, headers });

  // Access token expired → swap the refresh token for a new pair and retry once
  if (res.status === 401 && !skipAuth && getRefreshToken()) {
    const newerToken = getAccessToken();
    if (
      (newerToken && headers.get("Authorization") !== `Bearer ${newerToken}`) ||
      (await refreshAccessToken())
    ) {
      headers.set("Authorization", `Bearer ${getAccessToken() ?? ""}`);
      res = await fetch(`${BASE}${path}`, { ...init, headers });
    }
  }

  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // ignore parse failure
    }
    throw new ApiError(res.status, message);
  }

  // 204 No Content
  if (res.status === 204) return undefined as T;

  return res.json() as Promise<T>;
}

// ── Response types ─────────────────────────────────────────────────────────────

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: "STUDENT" | "TEACHER" | "ADMIN";
}

export interface BotUrlResponse {
  url: string;
}

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  user: AuthUser;
}

export interface ApiSubject {
  id: string;
  code: string;
  name: string;
  semester: number;
  branch: string;
  branchCode: string;
  paperCount: number;
}

export interface ApiPaper {
  id: string;
  subjectCode: string;
  subjectId: string;
  subjectName: string;
  branch: string;
  branchCode: string;
  semester: number;
  title: string;
  year: number;
  examType: string; // "Mid-Sem" | "End-Sem"
  size: string; // "1.2 MB"
  pdfUrl: string;
  uploadedAt: string;
}

// ── Auth ──────────────────────────────────────────────────────────────────────

export async function apiLogin(email: string, password: string): Promise<LoginResponse> {
  return apiFetch<LoginResponse>(
    "/api/auth/login",
    { method: "POST", body: JSON.stringify({ email, password }) },
    true, // don't attach token — we don't have one yet
  );
}

export async function apiLogout(refreshToken: string): Promise<void> {
  return apiFetch<void>("/api/auth/logout", {
    method: "POST",
    body: JSON.stringify({ refreshToken }),
  });
}

// ── Subjects ──────────────────────────────────────────────────────────────────

export interface SubjectFilters {
  branchId?: string | undefined;
  branch?: string | undefined;
  semester?: number | undefined;
  search?: string | undefined;
}

export async function fetchSubjects(
  filters: SubjectFilters,
  signal?: AbortSignal,
): Promise<ApiSubject[]> {
  const params = new URLSearchParams();
  if (filters.branchId) params.set("branchId", filters.branchId);
  if (filters.branch) params.set("branch", filters.branch);
  if (filters.semester) params.set("semester", String(filters.semester));
  if (filters.search) params.set("search", filters.search);

  const qs = params.toString() ? `?${params.toString()}` : "";
  const data = await apiFetch<{ subjects: ApiSubject[] }>(
    `/api/subjects${qs}`,
    signal ? { signal } : {},
  );
  return data.subjects;
}

export async function createSubject(body: {
  code: string;
  name: string;
  semester: number;
  branchId: string;
}): Promise<ApiSubject> {
  const data = await apiFetch<{ subject: ApiSubject }>("/api/subjects", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return data.subject;
}

export async function updateSubject(
  id: string,
  body: {
    code?: string | undefined;
    name?: string | undefined;
    semester?: number | undefined;
    branchId?: string | undefined;
  },
): Promise<ApiSubject> {
  const data = await apiFetch<{ subject: ApiSubject }>(`/api/subjects/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
  return data.subject;
}

export async function deleteSubject(id: string): Promise<void> {
  await apiFetch<void>(`/api/subjects/${id}`, { method: "DELETE" });
}

// ── Papers / Resources ────────────────────────────────────────────────────────

export interface PaperFilters {
  branch?: string | undefined;
  semester?: number | undefined;
  subjectCode?: string | undefined;
}

export async function fetchPapers(filters: PaperFilters): Promise<ApiPaper[]> {
  const params = new URLSearchParams();
  if (filters.branch) params.set("branch", filters.branch);
  if (filters.semester) params.set("semester", String(filters.semester));
  if (filters.subjectCode) params.set("subjectCode", filters.subjectCode);

  const qs = params.toString() ? `?${params.toString()}` : "";
  const data = await apiFetch<{ resources: ApiPaper[] }>(`/api/resources${qs}`);
  return data.resources;
}

export interface UploadPaperArgs {
  file: File;
  subjectCode: string;
  branch?: string | undefined;
  year: number;
  examType: string;
}

export async function uploadPaper(args: UploadPaperArgs): Promise<ApiPaper> {
  const form = new FormData();
  form.append("file", args.file);
  form.append("subjectCode", args.subjectCode);
  if (args.branch) form.append("branch", args.branch);
  form.append("year", String(args.year));
  form.append("examType", args.examType);

  const data = await apiFetch<{ resource: ApiPaper }>("/api/resources", {
    method: "POST",
    body: form,
  });
  return data.resource;
}

export async function deletePaper(id: string): Promise<void> {
  return apiFetch<void>(`/api/resources/${id}`, { method: "DELETE" });
}

// ── RAG: Papers by topic (semantic search) ────────────────────────────────────

export interface ApiPaperWithScore extends ApiPaper {
  similarityScore: number;
}

export interface PapersByTopicResponse {
  resources: ApiPaperWithScore[];
  ragEnabled: boolean; // false when no embedding key is configured
}

/**
 * Find PYQ papers that contain content semantically related to a topic.
 * Uses pgvector cosine similarity search on the backend.
 * Returns an empty list (ragEnabled: false) when no GEMINI/HF key is set.
 */
export async function fetchPapersByTopic(
  topic: string,
  subjectId?: string,
  topK = 5,
): Promise<PapersByTopicResponse> {
  const params = new URLSearchParams({ topic });
  if (subjectId) params.set("subjectId", subjectId);
  if (topK !== 5) params.set("topK", String(topK));
  return apiFetch<PapersByTopicResponse>(`/api/resources/by-topic?${params.toString()}`);
}

// ── External paper-chat handoff ────────────────────────────────────────────────

export async function fetchBotUrl(resourceId?: string): Promise<string> {
  const qs = resourceId ? `?resourceId=${encodeURIComponent(resourceId)}` : "";
  const data = await apiFetch<BotUrlResponse>(`/api/bot/url${qs}`);
  return data.url;
}

// ── Study Plans ───────────────────────────────────────────────────────────────

/** One subject block inside a day (new plans only; old plans have sessions = null). */
export interface ApiStudySession {
  subjectId: string | null;
  subjectName?: string | null;
  subjectCode?: string | null;
  kind: "learn" | "revision" | "exam" | "focus" | "buffer";
  minutes: number;
  topics: string[];
  done?: boolean;
}

export interface ApiStudyPlanDay {
  id: string;
  dayNumber: number;
  date: string | null;
  topics: string[];
  isCompleted: boolean;
  notes: string | null;
  subject: { id: string; name: string; code: string } | null;
  sessions?: ApiStudySession[] | null;
}

export interface ApiStudyPlan {
  id: string;
  title: string;
  examDate: string | null;
  totalDays: number;
  status: "ACTIVE" | "COMPLETED" | "PAUSED";
  groupId: string | null;
  createdAt: string;
  days: ApiStudyPlanDay[];
}

export async function fetchStudyPlans(): Promise<ApiStudyPlan[]> {
  const data = await apiFetch<{ plans: ApiStudyPlan[] }>("/api/study-plans");
  return data.plans;
}

export async function createStudyPlan(body: {
  title: string;
  examDate?: string | undefined;
  totalDays: number;
  topics?: string[] | undefined;
}): Promise<ApiStudyPlan> {
  const data = await apiFetch<{ plan: ApiStudyPlan }>("/api/study-plans", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return data.plan;
}

export async function fetchStudyPlan(id: string): Promise<ApiStudyPlan> {
  const data = await apiFetch<{ plan: ApiStudyPlan }>(`/api/study-plans/${id}`);
  return data.plan;
}

export async function markDayComplete(
  planId: string,
  dayId: string,
  isCompleted: boolean,
): Promise<void> {
  await apiFetch<void>(`/api/study-plans/${planId}/days/${dayId}`, {
    method: "PATCH",
    body: JSON.stringify({ isCompleted }),
  });
}

/** Tick / un-tick one subject block of a day. The day completes when all its blocks are done. */
export async function markSessionDone(
  planId: string,
  dayId: string,
  index: number,
  done: boolean,
): Promise<void> {
  await apiFetch<void>(`/api/study-plans/${planId}/days/${dayId}/sessions/${index}`, {
    method: "PATCH",
    body: JSON.stringify({ done }),
  });
}

export interface ApiCatchUpResult {
  plan: ApiStudyPlan | null;
  warnings: string[];
  stats: {
    subjectId: string;
    name: string;
    learnMinutes: number;
    revisionMinutes: number;
    unscheduledMinutes: number;
    unscheduledTopics: string[];
  }[];
}

/** Keep finished days, re-plan the rest from today up to the last exam. */
export async function catchUpStudyPlan(planId: string): Promise<ApiCatchUpResult> {
  return apiFetch<ApiCatchUpResult>(`/api/study-plans/${planId}/catch-up`, { method: "POST" });
}

export async function deleteStudyPlan(id: string): Promise<void> {
  await apiFetch<void>(`/api/study-plans/${id}`, { method: "DELETE" });
}

// ── Study Groups ──────────────────────────────────────────────────────────────

export interface ApiGroupMember {
  id: string;
  name: string;
  email: string;
  role: "OWNER" | "MEMBER";
}

export interface ApiStudyGroup {
  id: string;
  name: string;
  description: string | null;
  inviteCode: string;
  branch: string | null;
  semester: number | null;
  memberCount: number;
  members?: ApiGroupMember[];
  myRole: "OWNER" | "MEMBER" | null;
}

export async function fetchGroups(): Promise<ApiStudyGroup[]> {
  const data = await apiFetch<{ groups: ApiStudyGroup[] }>("/api/groups");
  return data.groups;
}

export async function createGroup(body: {
  name: string;
  description?: string | undefined;
  branch?: string | undefined;
  semester?: number | undefined;
}): Promise<ApiStudyGroup> {
  const data = await apiFetch<{ group: ApiStudyGroup }>("/api/groups", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return data.group;
}

export async function fetchGroup(id: string): Promise<ApiStudyGroup> {
  const data = await apiFetch<{ group: ApiStudyGroup }>(`/api/groups/${id}`);
  return data.group;
}

export async function joinGroup(inviteCode: string): Promise<ApiStudyGroup> {
  const data = await apiFetch<{ group: ApiStudyGroup }>("/api/groups/join", {
    method: "POST",
    body: JSON.stringify({ inviteCode }),
  });
  return data.group;
}

export async function leaveGroup(id: string): Promise<void> {
  await apiFetch<void>(`/api/groups/${id}/leave`, { method: "DELETE" });
}

// ── Student Dashboard ─────────────────────────────────────────────────────────

export interface ApiDashboardData {
  userName: string;
  needsOnboarding: boolean;
  hasTakenQuiz: boolean;
  streak: {
    current: number;
    week: { date: string; label: string; active: boolean; isToday: boolean }[];
  };
  today: {
    plan: {
      id: string;
      title: string;
      examDate: string | null;
      daysLeft: number | null;
      totalDays: number;
      doneDays: number;
      pace: { status: "ahead" | "on_track" | "behind"; delta: number };
    };
    kind: "today" | "overdue" | "upcoming" | "none";
    day: {
      id: string;
      dayNumber: number;
      date: string | null;
      topics: string[];
      isCompleted: boolean;
      subject: { id: string; name: string; code: string } | null;
    } | null;
    overdueCount: number;
    activePlanCount: number;
  } | null;
  practice: {
    topic: string;
    subjectId: string | null;
    averageScore: number;
    latestScore: number;
    trend: number | null;
    attempts: number;
  }[];
  continueReading: {
    resourceId: string;
    title: string;
    fileUrl: string;
    subjectName: string;
    subjectCode: string;
    viewedAt: string;
  } | null;
  readiness: {
    subjectId: string;
    subjectName: string;
    subjectCode: string;
    semester: number;
    score: number | null;
    quizAverage: number | null;
    planDone: number;
    planTotal: number;
    viewedPapers: number;
    totalPapers: number;
  }[];
}

export async function fetchDashboardData(): Promise<ApiDashboardData> {
  return apiFetch<ApiDashboardData>("/api/dashboard/me");
}

export async function trackActivity(body: {
  resourceId: string;
  activityType: "VIEW" | "DOWNLOAD";
  metadata?: Record<string, unknown> | undefined;
}): Promise<void> {
  await apiFetch<void>("/api/dashboard/activity", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// ── MCQ ───────────────────────────────────────────────────────────────────────

export interface ApiMCQQuestion {
  id: string;
  question: string;
  options: string[];
  topic: string | null;
}

export interface ApiMCQSession {
  sessionId: string;
  questions: ApiMCQQuestion[];
}

export interface ApiMCQResult {
  score: number;
  correctQ: number;
  totalQ: number;
  results: {
    questionId: string;
    correct: boolean;
    correctIndex: number;
    explanation: string | null;
  }[];
}

export async function generateMCQ(body: {
  subjectId?: string | undefined;
  topic?: string | undefined;
  count?: number | undefined;
}): Promise<ApiMCQSession> {
  return apiFetch<ApiMCQSession>("/api/mcq/generate", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function submitMCQAnswers(
  sessionId: string,
  answers: { questionId: string; chosenIndex: number }[],
): Promise<ApiMCQResult> {
  return apiFetch<ApiMCQResult>(`/api/mcq/sessions/${sessionId}/answer`, {
    method: "POST",
    body: JSON.stringify({ answers }),
  });
}

export async function fetchMCQSessions(): Promise<
  {
    id: string;
    topic: string | null;
    score: number;
    totalQ: number;
    correctQ: number;
    answeredCount: number;
    createdAt: string;
  }[]
> {
  const data = await apiFetch<{
    sessions: {
      id: string;
      topic: string | null;
      score: number;
      totalQ: number;
      correctQ: number;
      answeredCount: number;
      createdAt: string;
    }[];
  }>("/api/mcq/sessions");
  return data.sessions;
}

/** Fetch a single session's questions, stripping correctIndex so answers stay hidden during play. */
export async function fetchMCQSession(sessionId: string): Promise<ApiMCQSession> {
  const data = await apiFetch<{
    session: {
      id: string;
      questions: {
        id: string;
        question: string;
        options: string[];
        correctIndex: number;
        chosenIndex: number | null;
        explanation: string | null;
        topic: string | null;
      }[];
    };
  }>(`/api/mcq/sessions/${sessionId}`);
  return {
    sessionId: data.session.id,
    questions: data.session.questions.map(({ id, question, options, topic }) => ({
      id,
      question,
      options,
      topic,
    })),
  };
}

export async function deleteMCQSession(sessionId: string): Promise<void> {
  await apiFetch<void>(`/api/mcq/sessions/${sessionId}`, { method: "DELETE" });
}

// ── Flashcards ────────────────────────────────────────────────────────────────

export interface ApiFlashcard {
  id: string;
  front: string;
  back: string;
  easeFactor: number;
  interval: number;
  repetitions: number;
  nextReview: string;
}

export interface ApiFlashcardSet {
  id: string;
  title: string;
  topic: string | null;
  _count?: { cards: number };
  cardCount?: number;
  dueCount?: number;
  createdAt: string;
  cards?: ApiFlashcard[];
}

export async function fetchFlashcardSets(): Promise<ApiFlashcardSet[]> {
  const data = await apiFetch<{ sets: ApiFlashcardSet[] }>("/api/flashcards");
  return data.sets;
}

export async function generateFlashcards(body: {
  topic: string;
  subjectId?: string | undefined;
  count?: number | undefined;
}): Promise<ApiFlashcardSet> {
  const data = await apiFetch<{ set: ApiFlashcardSet }>("/api/flashcards/generate", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return data.set;
}

/** All cards in a set, regardless of review schedule. */
export async function fetchFlashcardSet(
  id: string,
): Promise<ApiFlashcardSet & { cards: ApiFlashcard[] }> {
  const data = await apiFetch<{ set: ApiFlashcardSet & { cards: ApiFlashcard[] } }>(
    `/api/flashcards/${id}/all`,
  );
  return data.set;
}

/** Only the cards that are due for review (SM-2 schedule). */
export async function fetchDueFlashcards(
  id: string,
): Promise<ApiFlashcardSet & { cards: ApiFlashcard[] }> {
  const data = await apiFetch<{ set: ApiFlashcardSet & { cards: ApiFlashcard[] } }>(
    `/api/flashcards/${id}`,
  );
  return data.set;
}

export async function reviewFlashcard(cardId: string, quality: number): Promise<ApiFlashcard> {
  const data = await apiFetch<{ card: ApiFlashcard }>(`/api/flashcards/cards/${cardId}/review`, {
    method: "PATCH",
    body: JSON.stringify({ quality }),
  });
  return data.card;
}

export async function deleteFlashcardSet(id: string): Promise<void> {
  await apiFetch<void>(`/api/flashcards/${id}`, { method: "DELETE" });
}

// ── Syllabus ──────────────────────────────────────────────────────────────────

export interface ApiSyllabusItem {
  id: string;
  unitNumber: number;
  title: string;
  topics: string[];
  hours: number | null;
  subjectId: string | null;
  subjectName: string | null;
}

export interface ApiSyllabus {
  id: string;
  branchId: string;
  branchName: string;
  branchCode: string;
  semester: number;
  scheme: string;
  description: string | null;
  items: ApiSyllabusItem[];
}

export async function fetchSyllabi(filters?: {
  branchId?: string | undefined;
  semester?: number | undefined;
  scheme?: string | undefined;
  subjectId?: string | undefined;
}): Promise<ApiSyllabus[]> {
  const params = new URLSearchParams();
  if (filters?.branchId) params.set("branchId", filters.branchId);
  if (filters?.semester) params.set("semester", String(filters.semester));
  if (filters?.scheme) params.set("scheme", filters.scheme);
  if (filters?.subjectId) params.set("subjectId", filters.subjectId);
  const qs = params.toString() ? `?${params.toString()}` : "";
  const data = await apiFetch<{ syllabi: ApiSyllabus[] }>(`/api/syllabus${qs}`);
  return data.syllabi;
}

export async function fetchSyllabus(id: string): Promise<ApiSyllabus> {
  const data = await apiFetch<{ syllabus: ApiSyllabus }>(`/api/syllabus/${id}`);
  return data.syllabus;
}

export async function createSyllabus(body: {
  branchId: string;
  semester: number;
  scheme?: string | undefined;
  description?: string | undefined;
}): Promise<ApiSyllabus> {
  const data = await apiFetch<{ syllabus: ApiSyllabus }>("/api/syllabus", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return data.syllabus;
}

export async function addSyllabusItem(
  syllabusId: string,
  body: {
    unitNumber: number;
    title: string;
    topics: string[];
    hours?: number | undefined;
    subjectId?: string | undefined;
  },
): Promise<ApiSyllabusItem> {
  const data = await apiFetch<{ item: ApiSyllabusItem }>(`/api/syllabus/${syllabusId}/items`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return data.item;
}

export async function updateSyllabusItem(
  syllabusId: string,
  itemId: string,
  body: {
    unitNumber?: number | undefined;
    title?: string | undefined;
    topics?: string[] | undefined;
    hours?: number | undefined;
    subjectId?: string | undefined;
  },
): Promise<ApiSyllabusItem> {
  const data = await apiFetch<{ item: ApiSyllabusItem }>(
    `/api/syllabus/${syllabusId}/items/${itemId}`,
    {
      method: "PATCH",
      body: JSON.stringify(body),
    },
  );
  return data.item;
}

export async function deleteSyllabusItem(syllabusId: string, itemId: string): Promise<void> {
  await apiFetch<void>(`/api/syllabus/${syllabusId}/items/${itemId}`, { method: "DELETE" });
}

export async function deleteSyllabus(id: string): Promise<void> {
  await apiFetch<void>(`/api/syllabus/${id}`, { method: "DELETE" });
}

// ── User Profile ──────────────────────────────────────────────────────────────

export interface ApiUserProfile {
  id: string;
  userId: string;
  year: number | null;
  semester: number | null;
  branchId: string | null;
  branch: { id: string; name: string; code: string } | null;
  subjects: {
    id: string;
    subject: { id: string; code: string; name: string; semester: number };
  }[];
}

export async function fetchProfile(): Promise<ApiUserProfile> {
  const data = await apiFetch<{ profile: ApiUserProfile }>("/api/profile");
  return data.profile;
}

export async function updateProfile(body: {
  year?: number | null | undefined;
  semester?: number | null | undefined;
  branchId?: string | null | undefined;
}): Promise<ApiUserProfile> {
  const data = await apiFetch<{ profile: ApiUserProfile }>("/api/profile", {
    method: "PUT",
    body: JSON.stringify(body),
  });
  return data.profile;
}

export async function addProfileSubject(subjectId: string): Promise<ApiUserProfile> {
  const data = await apiFetch<{ profile: ApiUserProfile }>(`/api/profile/subjects/${subjectId}`, {
    method: "POST",
  });
  return data.profile;
}

export async function removeProfileSubject(subjectId: string): Promise<ApiUserProfile> {
  const data = await apiFetch<{ profile: ApiUserProfile }>(`/api/profile/subjects/${subjectId}`, {
    method: "DELETE",
  });
  return data.profile;
}

// ── Branches ──────────────────────────────────────────────────────────────────

export interface ApiBranch {
  id: string;
  name: string;
  code: string;
}

export async function fetchBranches(): Promise<ApiBranch[]> {
  const data = await apiFetch<{ branches: ApiBranch[] }>("/api/branches");
  return data.branches;
}

export async function createBranch(body: { name: string; code: string }): Promise<ApiBranch> {
  const data = await apiFetch<{ branch: ApiBranch }>("/api/branches", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return data.branch;
}

export async function deleteBranch(id: string): Promise<void> {
  await apiFetch<void>(`/api/branches/${id}`, { method: "DELETE" });
}

export async function generateStudyPlan(body: {
  title: string;
  examDate?: string | undefined;
  totalDays: number;
}): Promise<{ plan: ApiStudyPlan; subjectsUsed: number }> {
  return apiFetch<{ plan: ApiStudyPlan; subjectsUsed: number }>("/api/study-plans/generate", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export interface ApiExtractedExam {
  subjectName: string;
  date: string;
}

export async function parseTimetable(file: File): Promise<ApiExtractedExam[]> {
  const form = new FormData();
  form.append("file", file);
  const data = await apiFetch<{ exams: ApiExtractedExam[] }>("/api/study-plans/parse-timetable", {
    method: "POST",
    body: form,
  });
  return data.exams;
}

export async function generateStudyPlanSmart(body: {
  title: string;
  startDate?: string | undefined;
  /** Omit to plan until the last exam (30 days if there are none). */
  totalDays?: number | undefined;
  hoursPerDay?: number | undefined;
  exams?: ApiExtractedExam[] | undefined;
  /** SyllabusItem IDs to skip — all other units are included. */
  excludedUnitIds?: string[] | undefined;
}): Promise<{
  plan: ApiStudyPlan;
  subjectsUsed: number;
  examsMatched: number;
  warnings: string[];
}> {
  return apiFetch<{
    plan: ApiStudyPlan;
    subjectsUsed: number;
    examsMatched: number;
    warnings: string[];
  }>("/api/study-plans/generate", { method: "POST", body: JSON.stringify(body) });
}

// ── Group analytics ────────────────────────────────────────────────────────────

export interface ApiGroupAnalytics {
  weakTopics: {
    topic: string;
    avgScore: number;
    memberCount: number; // members who attempted the topic
    strugglingCount: number; // members whose own recent average is < 60
  }[];
  memberSubjects: { userId: string; subjects: { id: string; name: string; code: string }[] }[];
  sharedSubjects: { id: string; name: string; code: string; memberCount: number }[];
}

export async function fetchGroupAnalytics(groupId: string): Promise<ApiGroupAnalytics> {
  return apiFetch<ApiGroupAnalytics>(`/api/groups/${groupId}`);
}

export interface ApiGroupPlanResult {
  plan: ApiStudyPlan | null;
  weakTopicsUsed: number;
  subjectsUsed: number;
  warnings: string[];
}

export interface ApiGroupPlanOptions {
  subjects: {
    id: string;
    name: string;
    code: string;
    units: {
      id: string;
      unitNumber: number;
      title: string;
      topics: string[];
      hours: number | null;
    }[];
  }[];
}

export async function fetchGroupPlanOptions(groupId: string): Promise<ApiGroupPlanOptions> {
  return apiFetch<ApiGroupPlanOptions>(`/api/groups/${groupId}/plan/options`);
}

export async function generateGroupPlan(
  groupId: string,
  body: {
    title: string;
    /** Omit to plan until the last exam (30 days if there are none). */
    totalDays?: number | undefined;
    examDate?: string | undefined;
    hoursPerDay?: number | undefined;
    subjectExams?: { subjectId: string; date: string }[] | undefined;
    excludedUnitIds?: string[] | undefined;
  },
): Promise<ApiGroupPlanResult> {
  return apiFetch<ApiGroupPlanResult>(`/api/groups/${groupId}/plan/generate`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export interface ApiGroupMemberProgress {
  userId: string;
  name: string;
  isMe: boolean;
  hasPlan: boolean;
  planTitle: string | null;
  status: "ACTIVE" | "COMPLETED" | "PAUSED" | null;
  doneDays: number;
  totalDays: number;
  percentage: number;
}

export async function fetchGroupProgress(groupId: string): Promise<ApiGroupMemberProgress[]> {
  const res = await apiFetch<{ progress: ApiGroupMemberProgress[] }>(
    `/api/groups/${groupId}/progress`,
  );
  return res.progress;
}

export async function deleteGroupPlan(groupId: string): Promise<number> {
  const res = await apiFetch<{ deleted: number }>(`/api/groups/${groupId}/plan`, {
    method: "DELETE",
  });
  return res.deleted;
}

export async function removeGroupMember(groupId: string, userId: string): Promise<void> {
  await apiFetch<void>(`/api/groups/${groupId}/members/${userId}`, { method: "DELETE" });
}

export async function transferGroupOwnership(
  groupId: string,
  userId: string,
): Promise<ApiStudyGroup> {
  const res = await apiFetch<{ group: ApiStudyGroup }>(`/api/groups/${groupId}/transfer`, {
    method: "POST",
    body: JSON.stringify({ userId }),
  });
  return res.group;
}

export async function regenerateInviteCode(groupId: string): Promise<string> {
  const res = await apiFetch<{ inviteCode: string }>(`/api/groups/${groupId}/invite/regenerate`, {
    method: "POST",
  });
  return res.inviteCode;
}

export async function deleteGroup(groupId: string): Promise<void> {
  await apiFetch<void>(`/api/groups/${groupId}`, { method: "DELETE" });
}

export async function parseSyllabusText(
  syllabusId: string,
  text: string,
  subjectId?: string | undefined,
): Promise<{ items: ApiSyllabusItem[]; count: number }> {
  const data = await apiFetch<{ items: ApiSyllabusItem[]; count: number }>(
    `/api/syllabus/${syllabusId}/parse`,
    {
      method: "POST",
      body: JSON.stringify({ text, subjectId }),
    },
  );
  return data;
}

// ── PYQ finder (question-level search) ───────────────────────────────────────

export interface ApiPyqPaper {
  id: string;
  title: string;
  year: number;
  examType: string; // "Mid-Sem" | "End-Sem"
  subjectCode: string;
  subjectName: string;
  fileUrl: string;
}

export interface ApiPyqAppearance {
  questionId: string;
  label: string | null; // as printed, e.g. "Q3(b)"
  marks: number | null;
  pageNumber: number | null;
  paper: ApiPyqPaper;
}

/** One question. If it was repeated in several papers, `appearances` lists every paper (newest first). */
export interface ApiPyqQuestion {
  id: string;
  text: string; // exact text from the paper
  label: string | null;
  marks: number | null;
  score: number;
  similarity: number | null;
  exactMatch: boolean; // the topic phrase appears in the question
  termMatch: number; // 0..1, share of the topic's words found in the question
  source: "text" | "scan" | null; // "scan" = transcribed by vision model, may have minor errors
  appearances: ApiPyqAppearance[];
}

export interface ApiPyqPaperSummary {
  paper: ApiPyqPaper;
  questionCount: number;
  labels: string[];
}

export interface ApiPyqTopicResult {
  topic: string;
  questions: ApiPyqQuestion[];
  papers: ApiPyqPaperSummary[]; // which papers the matches come from, newest first
  years: number[];
}

export interface ApiPyqSearchResponse {
  ragEnabled: boolean; // false → keyword matches only
  semanticUnavailable: boolean; // embedding call failed just now
  coverage: { questionsIndexed: number; papersIndexed: number; totalPapers: number };
  results: ApiPyqTopicResult[];
}

export async function searchPyqQuestions(
  body: {
    topics: string[];
    subjectId?: string | undefined;
    context?: string | undefined;
    perTopic?: number | undefined;
  },
  signal?: AbortSignal,
): Promise<ApiPyqSearchResponse> {
  return apiFetch<ApiPyqSearchResponse>("/api/questions/search", {
    method: "POST",
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
}

// ── AI Agent (streaming chat) ────────────────────────────────────────────────

export interface ApiMockQuestion {
  no: number;
  text: string;
  marks: number;
  origin: "pyq" | "variant" | "new";
  unit: string;
  topic: string;
  source?: string;
}

export interface ApiMockPaper {
  title: string;
  subjectName: string;
  subjectCode: string;
  totalMarks: number;
  durationMinutes: number;
  instructions: string[];
  sections: { name: string; instructions: string; questions: ApiMockQuestion[] }[];
  coverage: { unit: string; questions: number; marks: number }[];
  generatedOn: string;
}

export interface AgentEvent {
  type: "tool_call" | "tool_result" | "artifact" | "token" | "message" | "retry" | "done" | "error";
  id?: string;
  name?: string;
  args?: string;
  result?: string;
  content?: string;
  message?: string;
  artifact?: { kind: "mock_paper"; paper: ApiMockPaper };
}

export async function streamAgentChat(
  message: string,
  history: { role: "user" | "assistant"; content: string }[],
  onEvent: (event: AgentEvent) => void,
): Promise<void> {
  const doFetch = async () => {
    const token = getAccessToken();
    return fetch(`${BASE}/api/agent/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ message, history }),
    });
  };

  let res = await doFetch();

  // Token expired — refresh and retry once
  if (res.status === 401 && getRefreshToken()) {
    if (await refreshAccessToken()) {
      res = await doFetch();
    }
  }

  if (!res.ok) {
    let msg = res.statusText;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) msg = body.error;
    } catch {
      // ignore
    }
    throw new ApiError(res.status, msg);
  }

  if (!res.body)
    throw new ApiError(502, "The AI response stream is unavailable. Please try again.");
  await readJsonEventStream<AgentEvent>(res.body, onEvent);
}
