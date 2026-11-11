import { useEffect, useRef, useState } from "react";
import { Upload, FileText, Loader2 } from "lucide-react";
import { SEMESTERS, BRANCHES, type ExamType, type Paper } from "@/lib/campus-data";
import { uploadPaper, fetchSubjects, ApiError } from "@/lib/api";

const UPLOAD_YEARS = [2026, 2025, 2024, 2023, 2022, 2021];

const ACCEPTED_TYPES = "application/pdf,image/png,image/jpeg,image/webp,image/gif";

function isAcceptedFile(file: File): boolean {
  return file.type === "application/pdf" || file.type.startsWith("image/");
}

const selectClass =
  "h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none transition hover:border-primary/40 focus:border-primary focus:ring-2 focus:ring-primary/15 disabled:cursor-not-allowed disabled:opacity-60";
const labelClass = "text-xs font-semibold text-muted-foreground";

type Props = {
  /** Called with the newly uploaded paper so the table updates immediately */
  onAdd: (paper: Paper) => void;
};

export function UploadCard({ onAdd }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [year, setYear] = useState<number>(UPLOAD_YEARS[0]!);
  const [examType, setExamType] = useState<ExamType>("End-Sem");
  const [filterBranch, setFilterBranch] = useState<string>("Computer Science");
  const [semester, setSemester] = useState<number>(1);
  const [subjectCode, setSubjectCode] = useState<string>("");
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  // Subjects fetched from the API
  const [allSubjects, setAllSubjects] = useState<
    { code: string; name: string; semester: number; branch: string }[]
  >([]);
  const [subjectsLoading, setSubjectsLoading] = useState(false);

  // Fetch all subjects once on mount
  useEffect(() => {
    setSubjectsLoading(true);
    fetchSubjects({})
      .then((data) => {
        setAllSubjects(
          data.map((s) => ({ code: s.code, name: s.name, semester: s.semester, branch: s.branch })),
        );
      })
      .catch(() => {
        /* silently fail */
      })
      .finally(() => setSubjectsLoading(false));
  }, []);

  // Subjects filtered by branch + semester
  const filteredSubjects = allSubjects.filter(
    (s) => s.branch === filterBranch && s.semester === semester,
  );

  // Keep subjectCode in sync when filtered list changes
  useEffect(() => {
    if (filteredSubjects.length > 0) {
      setSubjectCode(filteredSubjects[0]!.code);
    } else {
      setSubjectCode("");
    }
  }, [filterBranch, semester, allSubjects]); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) {
      setMessage({ text: "Please attach a PDF or image file first.", error: true });
      return;
    }
    if (!subjectCode) {
      setMessage({ text: "No subjects found for this branch and semester.", error: true });
      return;
    }

    setUploading(true);
    setMessage(null);

    try {
      const apiPaper = await uploadPaper({
        file,
        subjectCode,
        branch: filterBranch,
        year,
        examType,
      });

      const paper: Paper = {
        id: apiPaper.id,
        subjectCode: apiPaper.subjectCode,
        title: apiPaper.title,
        year: apiPaper.year,
        examType: apiPaper.examType as ExamType,
        size: apiPaper.size,
        pdfUrl: apiPaper.pdfUrl,
      };

      onAdd(paper);
      setFile(null);
      setMessage({ text: `Uploaded to ${subjectCode} · Semester ${semester}.`, error: false });
    } catch (err) {
      const text = err instanceof ApiError ? err.message : "Upload failed. Please try again.";
      setMessage({ text, error: true });
    } finally {
      setUploading(false);
    }
  }

  return (
    <section className="card p-6 sm:p-7">
      <div className="flex items-center gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-accent text-primary">
          <Upload className="size-5" />
        </span>
        <div>
          <h2 className="text-base font-semibold leading-tight text-foreground">Upload PYQ Paper</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Add a previous year question paper to the repository.
          </p>
        </div>
      </div>

      <form onSubmit={submit} className="mt-6 space-y-6">
        {/* Drop zone */}
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const dropped = e.dataTransfer.files?.[0];
            if (dropped && isAcceptedFile(dropped)) setFile(dropped);
            else setMessage({ text: "Only PDF or image files are accepted.", error: true });
          }}
          onClick={() => inputRef.current?.click()}
          className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors ${
            dragging
              ? "border-primary bg-accent"
              : file
                ? "border-primary/50 bg-accent/40"
                : "border-border bg-background/60 hover:border-primary/60 hover:bg-accent/30"
          }`}
        >
          <span className="flex size-11 items-center justify-center rounded-full bg-background text-primary shadow-sm ring-1 ring-border">
            <FileText className="size-5" />
          </span>
          <p className="mt-3 text-sm font-semibold text-foreground">
            {file ? file.name : "Drop PDF or image here or click to browse"}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">PDF or image, max 25 MB</p>
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPTED_TYPES}
            className="hidden"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </div>

        {/* Filters + metadata */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1.8fr_0.8fr_1fr]">
          <div className="space-y-1.5">
            <label className={labelClass} htmlFor="up-branch">
              Branch
            </label>
            <select
              id="up-branch"
              className={selectClass}
              value={filterBranch}
              onChange={(e) => setFilterBranch(e.target.value)}
            >
              {BRANCHES.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <label className={labelClass} htmlFor="up-sem">
              Semester
            </label>
            <select
              id="up-sem"
              className={selectClass}
              value={semester}
              onChange={(e) => setSemester(Number(e.target.value))}
            >
              {SEMESTERS.map((s) => (
                <option key={s} value={s}>
                  Semester {s}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <label className={labelClass} htmlFor="up-subject">
              Subject
            </label>
            <select
              id="up-subject"
              className={selectClass}
              value={subjectCode}
              onChange={(e) => setSubjectCode(e.target.value)}
              disabled={subjectsLoading || filteredSubjects.length === 0}
            >
              {subjectsLoading ? (
                <option>Loading…</option>
              ) : filteredSubjects.length === 0 ? (
                <option>No subjects found</option>
              ) : (
                filteredSubjects.map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.code} - {s.name}
                  </option>
                ))
              )}
            </select>
          </div>
          <div className="space-y-1.5">
            <label className={labelClass} htmlFor="up-year">
              Year
            </label>
            <select
              id="up-year"
              className={selectClass}
              value={year}
              onChange={(e) => setYear(Number(e.target.value))}
            >
              {UPLOAD_YEARS.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <label className={labelClass} htmlFor="up-type">
              Exam Type
            </label>
            <select
              id="up-type"
              className={selectClass}
              value={examType}
              onChange={(e) => setExamType(e.target.value as ExamType)}
            >
              <option value="Mid-Sem">Mid-Sem</option>
              <option value="End-Sem">End-Sem</option>
            </select>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={uploading}
            className="inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-5 text-sm font-semibold text-primary-foreground shadow-sm transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            {uploading && <Loader2 className="size-4 animate-spin" />}
            {uploading ? "Uploading…" : "Upload Paper"}
          </button>
          {message && (
            <p
              className={`text-xs ${message.error ? "text-destructive" : "text-muted-foreground"}`}
            >
              {message.text}
            </p>
          )}
        </div>
      </form>
    </section>
  );
}
