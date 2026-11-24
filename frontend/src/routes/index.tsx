import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Brain,
  CheckCircle2,
  FileText,
  Layers,
  Sparkles,
  Users,
  Calendar,
  HelpCircle,
  Zap,
  RotateCw,
  Flame,
} from "lucide-react";
import {
  motion,
  AnimatePresence,
  useMotionValue,
  useSpring,
  useTransform,
  useMotionTemplate,
} from "motion/react";
import { fetchBotUrl } from "@/lib/api";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "CampusBrain — Previous year papers, and a better way to revise" },
      {
        name: "description",
        content:
          "Browse previous year question papers by branch and semester, chat with any paper, drill MCQs, review flashcards and build a day-by-day study plan.",
      },
    ],
  }),
  component: LandingPage,
});

const tools = [
  {
    n: "01",
    title: "Papers, organised the way you think",
    body: "Pick your year, semester and branch. Every paper is one click from a download, and one more from a conversation about it.",
    to: "/dashboard" as const,
    cta: "Open the papers",
    tag: "ARCHIVE + AI CHAT",
    icon: FileText,
    previewType: "paper" as const,
  },
  {
    n: "02",
    title: "Quizzes that find your weak spots",
    body: "Generate a set of multiple-choice questions on any subject or topic. Topics where you keep slipping show up on your dashboard.",
    to: "/mcq" as const,
    cta: "Take a quiz",
    tag: "ADAPTIVE DRILLING",
    icon: HelpCircle,
    previewType: "mcq" as const,
  },
  {
    n: "03",
    title: "Flashcards that come back when you need them",
    body: "Rate each card Hard, Okay or Easy. The SM-2 schedule brings hard cards back sooner and lets easy ones rest.",
    to: "/flashcards" as const,
    cta: "Make a deck",
    tag: "SM-2 SPACED REPETITION",
    icon: Layers,
    previewType: "flashcard" as const,
  },
  {
    n: "04",
    title: "A plan built from your timetable",
    body: "Upload your exam timetable PDF. We match it to your subjects and syllabus, then spread the topics across the days you have.",
    to: "/study" as const,
    cta: "Plan my exams",
    tag: "PDF-TO-SCHEDULE",
    icon: Calendar,
    previewType: "plan" as const,
  },
];

interface SampleQuestion {
  q: string;
  marks: string;
  highlight?: string;
  freq?: string;
}

interface SamplePaper {
  branch: string;
  sem: string;
  code: string;
  subject: string;
  questions: SampleQuestion[];
  aiPrompt: string;
  aiReply: string;
}

const samplePapers: [SamplePaper, ...SamplePaper[]] = [
  {
    branch: "CSE",
    sem: "Sem 3",
    code: "CS301",
    subject: "Data Structures",
    questions: [
      { q: "Compare an array and a linked list for insertion and lookup.", marks: "5M" },
      {
        q: "Explain AVL rotations with an example.",
        highlight: "Explain AVL rotations",
        marks: "10M",
        freq: "Asked 4× since 2021",
      },
      { q: "Write an algorithm for breadth-first traversal of a graph.", marks: "5M" },
    ],
    aiPrompt: "“Which tree questions repeat almost every year?”",
    aiReply: "AVL rotations (LL, RR, LR, RL) appeared in 4 of the last 5 End-Sem papers.",
  },
  {
    branch: "ECE",
    sem: "Sem 4",
    code: "EC402",
    subject: "Signals & Systems",
    questions: [
      { q: "State and prove the time-shifting property of Fourier Transform.", marks: "5M" },
      {
        q: "Find Nyquist rate and interval for x(t) = sinc(200t).",
        highlight: "Find Nyquist rate and interval",
        marks: "8M",
        freq: "Asked 3× since 2022",
      },
      { q: "Determine the region of convergence (ROC) for causal LTI systems.", marks: "7M" },
    ],
    aiPrompt: "“Give me a 2-step recipe for Nyquist rate numericals.”",
    aiReply: "1. Identify highest frequency fm in rad/s. 2. Multiply fm by 2 to get fN in Hz.",
  },
  {
    branch: "EEE",
    sem: "Sem 5",
    code: "EE501",
    subject: "Power Systems II",
    questions: [
      { q: "Derive the power flow equations for an n-bus system.", marks: "10M" },
      {
        q: "Compare Gauss-Seidel and Newton-Raphson load flow methods.",
        highlight: "Compare Gauss-Seidel and Newton-Raphson",
        marks: "8M",
        freq: "Asked 5× in a row",
      },
      { q: "Explain the equal area criterion for transient stability.", marks: "6M" },
    ],
    aiPrompt: "“Turn Q2 into a 4-point comparison table for 8 marks.”",
    aiReply: "Breakdown generated: Convergence speed, iterations, memory & Jacobian matrix.",
  },
];

const tickerItems = [
  "CS301 · DATA STRUCTURES",
  "EC402 · SIGNALS & SYSTEMS",
  "EE501 · POWER SYSTEMS II",
  "IT304 · OPERATING SYSTEMS",
  "CS401 · COMPILER DESIGN",
  "EC303 · DIGITAL ELECTRONICS",
  "SM-2 SPACED REPETITION",
  "AI PAPER BREAKDOWN",
];

/* -------------------------------------------------------------------------- */
/*                     CUSTOM PHYSICS & ANIMATION HELPERS                     */
/* -------------------------------------------------------------------------- */

/** Pulls its child slightly toward the user's cursor with spring physics */
function Magnetic({ children, strength = 0.28 }: { children: React.ReactNode; strength?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const springX = useSpring(x, { stiffness: 260, damping: 18, mass: 0.5 });
  const springY = useSpring(y, { stiffness: 260, damping: 18, mass: 0.5 });

  const handleMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const relX = e.clientX - (rect.left + rect.width / 2);
    const relY = e.clientY - (rect.top + rect.height / 2);
    x.set(relX * strength);
    y.set(relY * strength);
  };

  const handleLeave = () => {
    x.set(0);
    y.set(0);
  };

  return (
    <motion.div
      ref={ref}
      onMouseMove={handleMove}
      onMouseLeave={handleLeave}
      style={{ x: springX, y: springY }}
      className="inline-block"
    >
      {children}
    </motion.div>
  );
}

/** Terminal-style cipher scramble on hover or active trigger */
function ScrambleText({ text, active }: { text: string; active: boolean }) {
  const [display, setDisplay] = useState(text);
  const glyphs = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ#/_";

  useEffect(() => {
    if (!active) {
      setDisplay(text);
      return;
    }
    let frame = 0;
    const id = setInterval(() => {
      setDisplay(
        text
          .split("")
          .map((ch, idx) => {
            if (ch === " ") return " ";
            if (idx < frame / 1.5) return text[idx] ?? ch;
            return glyphs[Math.floor(Math.random() * glyphs.length)] ?? ch;
          })
          .join(""),
      );
      frame++;
      if (frame >= text.length * 1.5 + 2) {
        clearInterval(id);
        setDisplay(text);
      }
    }, 24);
    return () => clearInterval(id);
  }, [active, text]);

  return <span>{display}</span>;
}

/** Interactive Mini-Widgets inside Tool Rows on Hover */
function ToolLivePreview({ type }: { type: (typeof tools)[number]["previewType"] }) {
  const [flipped, setFlipped] = useState(false);

  if (type === "flashcard") {
    return (
      <div
        onClick={(e) => {
          e.preventDefault();
          setFlipped((f) => !f);
        }}
        className="w-56 cursor-pointer select-none rounded-md border border-border bg-background p-3 text-xs shadow-[4px_4px_0_0_var(--color-border)]"
      >
        <div className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          <span>SM-2 Card · Click to flip</span>
          <RotateCw className="size-3 text-primary" />
        </div>
        <motion.div
          key={flipped ? "back" : "front"}
          initial={{ rotateX: -80, opacity: 0 }}
          animate={{ rotateX: 0, opacity: 1 }}
          transition={{ type: "spring", stiffness: 300, damping: 20 }}
          className="mt-2 font-medium text-foreground"
        >
          {flipped
            ? "O(log n) — height stays balanced via rotations."
            : "Time complexity of lookup in an AVL tree?"}
        </motion.div>
        <div className="mt-2.5 flex gap-1.5">
          {["Hard · 10m", "Okay · 1d", "Easy · 4d"].map((b, i) => (
            <span
              key={b}
              className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${
                i === 2
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-secondary text-muted-foreground"
              }`}
            >
              {b}
            </span>
          ))}
        </div>
      </div>
    );
  }

  if (type === "mcq") {
    return (
      <div className="w-56 rounded-md border border-border bg-background p-3 text-xs shadow-[4px_4px_0_0_var(--color-border)]">
        <div className="flex items-center justify-between text-[10px] font-semibold uppercase text-muted-foreground">
          <span>Weak-Spot Drill</span>
          <span className="text-primary">Streak ×4</span>
        </div>
        <p className="mt-1.5 font-medium">Which traversal visits root last?</p>
        <div className="mt-2 space-y-1">
          {[
            { label: "A. In-order", ok: false },
            { label: "B. Post-order", ok: true },
          ].map((o) => (
            <div
              key={o.label}
              className={`flex items-center justify-between rounded border px-2 py-1 text-[11px] ${
                o.ok
                  ? "border-primary bg-highlight/35 font-semibold text-foreground"
                  : "border-border text-muted-foreground"
              }`}
            >
              <span>{o.label}</span>
              {o.ok && <span>✓ +10 XP</span>}
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (type === "plan") {
    return (
      <div className="w-56 rounded-md border border-border bg-background p-3 text-xs shadow-[4px_4px_0_0_var(--color-border)]">
        <div className="flex items-center justify-between text-[10px] font-semibold uppercase text-muted-foreground">
          <span>Auto-Schedule</span>
          <span className="text-primary">12 Days Left</span>
        </div>
        <div className="mt-2 space-y-1.5">
          {[
            { day: "Mon", topic: "Unit 1 · Trees", pct: "100%" },
            { day: "Tue", topic: "Unit 2 · Graphs", pct: "70%" },
            { day: "Wed", topic: "PYQ Mock Drill", pct: "40%" },
          ].map((d) => (
            <div key={d.day} className="space-y-0.5">
              <div className="flex justify-between text-[10px]">
                <span className="font-semibold">{d.day}</span>
                <span className="text-muted-foreground">{d.topic}</span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
                <motion.div
                  initial={{ width: 0 }}
                  animate={{ width: d.pct }}
                  transition={{ duration: 0.6, ease: "easeOut" }}
                  className="h-full bg-primary"
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="w-56 rounded-md border border-border bg-background p-3 text-xs shadow-[4px_4px_0_0_var(--color-border)]">
      <div className="flex items-center justify-between text-[10px] font-semibold uppercase text-muted-foreground">
        <span>PYQ Scanner</span>
        <span className="rounded bg-highlight/60 px-1.5 py-0.5 text-[9px] font-bold text-foreground">
          PDF READY
        </span>
      </div>
      <p className="mt-1.5 font-medium">CS301_EndSem_2025.pdf</p>
      <div className="mt-2 flex items-center gap-1.5 text-[11px] text-primary">
        <Sparkles className="size-3.5 animate-spin" />
        <span>AI indexed 18 questions...</span>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                              MAIN LANDING PAGE                             */
/* -------------------------------------------------------------------------- */

function LandingPage() {
  const [botUrl, setBotUrl] = useState<string | null>(null);
  useEffect(() => {
    fetchBotUrl()
      .then(setBotUrl)
      .catch(() => undefined);
  }, []);
  const [activePaperIdx, setActivePaperIdx] = useState(0);
  const [isHoveringPaper, setIsHoveringPaper] = useState(false);
  const [hoveredTool, setHoveredTool] = useState<string | null>(null);

  // Safe fallback guarantees activePaper is never undefined
  const activePaper: SamplePaper = samplePapers[activePaperIdx] ?? samplePapers[0];

  // 3D Tilt Motion Values for the Hero Paper Rig
  const paperRef = useRef<HTMLDivElement>(null);
  const mouseX = useMotionValue(0);
  const mouseY = useMotionValue(0);

  const rotateX = useSpring(useTransform(mouseY, [-0.5, 0.5], [11, -11]), {
    stiffness: 220,
    damping: 22,
  });
  const rotateY = useSpring(useTransform(mouseX, [-0.5, 0.5], [-11, 11]), {
    stiffness: 220,
    damping: 22,
  });
  const glareX = useSpring(useTransform(mouseX, [-0.5, 0.5], [0, 100]), {
    stiffness: 220,
    damping: 22,
  });
  const glareY = useSpring(useTransform(mouseY, [-0.5, 0.5], [0, 100]), {
    stiffness: 220,
    damping: 22,
  });
  const glareBackground = useMotionTemplate`radial-gradient(circle at ${glareX}% ${glareY}%, rgba(255,255,255,0.22), transparent 65%)`;

  const handlePaperMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = paperRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const nx = (e.clientX - rect.left) / rect.width - 0.5;
    const ny = (e.clientY - rect.top) / rect.height - 0.5;
    mouseX.set(nx);
    mouseY.set(ny);
  };

  const handlePaperMouseLeave = () => {
    setIsHoveringPaper(false);
    mouseX.set(0);
    mouseY.set(0);
  };

  // Auto-cycle hero paper unless hovered
  useEffect(() => {
    if (isHoveringPaper) return;
    const timer = setInterval(() => {
      setActivePaperIdx((prev) => (prev + 1) % samplePapers.length);
    }, 4800);
    return () => clearInterval(timer);
  }, [isHoveringPaper]);

  return (
    <div className="relative min-h-screen overflow-x-hidden bg-background text-foreground selection:bg-highlight selection:text-foreground">
      {/* Sticky Glass Nav */}
      <motion.nav
        initial={{ opacity: 0, y: -18 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 260, damping: 22 }}
        className="sticky top-0 z-40 border-b border-border/70 bg-background/80 backdrop-blur-md"
      >
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link to="/" className="group flex items-center gap-2.5">
            <motion.span
              whileHover={{ rotate: -14, scale: 1.12 }}
              whileTap={{ scale: 0.92 }}
              transition={{ type: "spring", stiffness: 500, damping: 14 }}
              className="flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground shadow-[2px_2px_0_0_var(--color-border)]"
            >
              <Brain className="size-4" />
            </motion.span>
            <span className="font-display text-lg font-semibold tracking-tight">CampusBrain</span>
          </Link>

          <div className="flex items-center gap-6 text-sm">
            {[
              { to: "/syllabus" as const, label: "Syllabus" },
              { to: "/mcq" as const, label: "Quizzes" },
              { to: "/flashcards" as const, label: "Flashcards" },
            ].map((item) => (
              <Link
                key={item.to}
                to={item.to}
                className="group relative hidden text-muted-foreground transition-colors hover:text-foreground sm:block"
              >
                {item.label}
                <span className="absolute -bottom-1 left-0 h-[2px] w-0 bg-primary transition-all duration-300 group-hover:w-full" />
              </Link>
            ))}

            <Magnetic strength={0.22}>
              <Link
                to="/dashboard"
                className="inline-flex h-9 items-center gap-1.5 rounded-md border border-primary bg-primary px-4 font-medium text-primary-foreground shadow-[3px_3px_0_0_var(--color-border)] transition-all hover:-translate-y-0.5 hover:shadow-[5px_5px_0_0_var(--color-border)] active:translate-y-0"
              >
                Browse papers
              </Link>
            </Magnetic>
          </div>
        </div>
      </motion.nav>

      {/* Hero Section */}
      <section className="relative z-10 mx-auto grid max-w-6xl gap-16 px-6 pb-20 pt-10 lg:grid-cols-[1.15fr_1fr] lg:items-center lg:pt-16">
        <div>
          {/* Live Pill Badge */}
          <motion.div
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ type: "spring", stiffness: 300, damping: 24 }}
            className="mb-6 inline-flex items-center gap-2.5 rounded-full border border-border bg-card px-3.5 py-1.5 text-xs font-medium text-muted-foreground shadow-[3px_3px_0_0_var(--color-border)]"
          >
            <span className="relative flex size-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
              <span className="relative inline-flex size-2 rounded-full bg-primary" />
            </span>
            <span>For engineering students · CSE, ECE, EEE, IT</span>
          </motion.div>

          {/* Word-by-word Spring Reveal Headline + Animated Marker Sweep */}
          <h1 className="text-5xl leading-[1.03] tracking-tight sm:text-6xl lg:text-7xl">
            {["Last", "year's", "paper", "is", "the", "best"].map((word, i) => (
              <motion.span
                key={word + i}
                initial={{ opacity: 0, y: 28, rotate: 2 }}
                animate={{ opacity: 1, y: 0, rotate: 0 }}
                transition={{
                  type: "spring",
                  stiffness: 260,
                  damping: 22,
                  delay: i * 0.055,
                }}
                className="mr-[0.26em] inline-block"
              >
                {word}
              </motion.span>
            ))}

            {/* Animated Self-Drawing Marker Highlight */}
            <motion.span
              initial={{ opacity: 0, scale: 0.92 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{
                type: "spring",
                stiffness: 280,
                damping: 18,
                delay: 0.36,
              }}
              className="relative mr-[0.26em] inline-block"
            >
              <motion.span
                initial={{ scaleX: 0 }}
                animate={{ scaleX: 1 }}
                transition={{
                  duration: 0.55,
                  delay: 0.55,
                  ease: [0.22, 1, 0.36, 1],
                }}
                style={{ originX: 0 }}
                className="marker absolute inset-0 -z-10 rounded-sm"
              />
              <span className="relative z-10 px-1">study guide</span>
            </motion.span>

            {["you", "have."].map((word, i) => (
              <motion.span
                key={word + i}
                initial={{ opacity: 0, y: 28 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{
                  type: "spring",
                  stiffness: 260,
                  damping: 22,
                  delay: 0.44 + i * 0.06,
                }}
                className="mr-[0.26em] inline-block"
              >
                {word}
              </motion.span>
            ))}
          </h1>

          <motion.p
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.55 }}
            className="mt-6 max-w-xl text-lg leading-relaxed text-muted-foreground"
          >
            CampusBrain keeps every previous year question paper in one place, then helps you
            actually use them: ask questions about a paper, quiz yourself, and plan the weeks before
            exams.
          </motion.p>

          {/* Magnetic CTAs */}
          <motion.div
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.65 }}
            className="mt-9 flex flex-wrap items-center gap-5"
          >
            <Magnetic strength={0.3}>
              <Link
                to="/dashboard"
                className="group relative inline-flex h-12 items-center gap-2.5 overflow-hidden rounded-md bg-primary px-6 font-medium text-primary-foreground shadow-[5px_5px_0_0_var(--color-border)] transition-all hover:-translate-y-0.5 hover:shadow-[7px_7px_0_0_var(--color-border)] active:translate-y-0"
              >
                <span className="relative z-10">Find my papers</span>
                <ArrowRight className="relative z-10 size-4 transition-transform duration-300 group-hover:translate-x-1.5" />
              </Link>
            </Magnetic>

            {botUrl && (
              <Magnetic strength={0.2}>
                <a
                  href={botUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group inline-flex items-center gap-1.5 font-medium underline decoration-highlight decoration-[3px] underline-offset-[6px] transition-colors hover:decoration-primary"
                >
                  Ask the AI assistant
                  <ArrowUpRight className="size-4 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
                </a>
              </Magnetic>
            )}
          </motion.div>

          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.8 }}
            className="mt-7 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-muted-foreground"
          >
            <div className="flex items-center gap-1.5">No account needed to browse & download.</div>
          </motion.div>
        </div>

        {/* 3D Interactive Perspective Paper Rig */}
        <motion.div
          initial={{ opacity: 0, scale: 0.9, y: 24 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ type: "spring", stiffness: 200, damping: 20, delay: 0.25 }}
          style={{ perspective: 1200 }}
          className="relative mx-auto w-full max-w-md pt-2"
        >
          {/* Branch Switcher Header with Animated Progress Bar */}
          <div className="mb-3 flex items-center justify-between">
            <div className="flex gap-1.5">
              {samplePapers.map((p, idx) => {
                const isActive = idx === activePaperIdx;
                return (
                  <button
                    key={p.code}
                    type="button"
                    onClick={() => setActivePaperIdx(idx)}
                    className={`relative overflow-hidden rounded px-2.5 py-1 text-xs font-semibold transition-all ${
                      isActive
                        ? "bg-primary text-primary-foreground shadow-[2px_2px_0_0_var(--color-border)]"
                        : "border border-border bg-card text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {p.branch}
                    {isActive && !isHoveringPaper && (
                      <motion.span
                        key={`timer-${activePaperIdx}`}
                        initial={{ scaleX: 0 }}
                        animate={{ scaleX: 1 }}
                        transition={{ duration: 4.8, ease: "linear" }}
                        style={{ originX: 0 }}
                        className="absolute bottom-0 left-0 right-0 h-[2.5px] bg-highlight"
                      />
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* 3D Tilt Container */}
          <motion.div
            ref={paperRef}
            onMouseEnter={() => setIsHoveringPaper(true)}
            onMouseMove={handlePaperMouseMove}
            onMouseLeave={handlePaperMouseLeave}
            style={{
              rotateX,
              rotateY,
              transformStyle: "preserve-3d",
            }}
            className="relative cursor-grab active:cursor-grabbing"
          >
            {/* Back Stacked Sheet 2 */}
            <div
              aria-hidden="true"
              style={{ transform: "translateZ(-28px) rotate(-3.5deg)" }}
              className="absolute inset-0 translate-x-4 translate-y-4 rounded-md border border-border bg-secondary/50"
            />
            {/* Back Stacked Sheet 1 */}
            <div
              aria-hidden="true"
              style={{ transform: "translateZ(-14px) rotate(2.2deg)" }}
              className="absolute inset-0 translate-x-2 translate-y-2 rounded-md border border-border bg-secondary/85"
            />

            {/* Foreground Active Exam Sheet */}
            <AnimatePresence mode="wait">
              <motion.div
                key={activePaper.code}
                initial={{ opacity: 0, y: 26, rotateZ: -4, scale: 0.94 }}
                animate={{ opacity: 1, y: 0, rotateZ: 1, scale: 1 }}
                exit={{ opacity: 0, x: 70, y: -20, rotateZ: 8, scale: 0.92 }}
                transition={{ type: "spring", stiffness: 320, damping: 24 }}
                style={{ transformStyle: "preserve-3d" }}
                className="relative overflow-hidden rounded-md border border-border bg-card p-7 shadow-[8px_8px_0_0_var(--color-border)]"
              >
                {/* Dynamic Cursor Glare Overlay */}
                <motion.div
                  aria-hidden="true"
                  style={{ background: glareBackground }}
                  className="pointer-events-none absolute inset-0 z-20"
                />

                {/* Top Stamp & Metadata */}
                <div className="flex items-baseline justify-between border-b border-border pb-3 text-xs uppercase tracking-widest text-muted-foreground">
                  <span>
                    End-Sem Exam · <strong className="text-foreground">{activePaper.code}</strong>
                  </span>
                  <span>{activePaper.sem}</span>
                </div>

                <div className="mt-4 flex items-center justify-between">
                  <h2 className="text-2xl">{activePaper.subject}</h2>
                  <motion.span
                    initial={{ scale: 1.4, rotate: -12, opacity: 0 }}
                    animate={{ scale: 1, rotate: -4, opacity: 1 }}
                    transition={{ type: "spring", stiffness: 400, damping: 15, delay: 0.15 }}
                    className="rounded border border-primary/50 bg-highlight/30 px-2 py-0.5 font-mono text-[11px] font-bold uppercase text-foreground"
                  >
                    VERIFIED PYQ
                  </motion.span>
                </div>

                <ol className="mt-5 space-y-4 text-sm leading-relaxed text-foreground/85">
                  {activePaper.questions.map((item, i) => (
                    <motion.li
                      key={item.q}
                      initial={{ opacity: 0, x: -12 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: 0.1 + i * 0.08 }}
                      className="flex items-start justify-between gap-3 rounded-md p-1.5 transition-colors hover:bg-secondary/60"
                    >
                      <div>
                        <span className="mr-2 font-semibold">Q{i + 1}.</span>
                        {item.highlight ? (
                          <>
                            <span className="relative inline-block font-medium text-foreground">
                              <motion.span
                                initial={{ scaleX: 0 }}
                                animate={{ scaleX: 1 }}
                                transition={{
                                  duration: 0.5,
                                  delay: 0.28,
                                  ease: [0.22, 1, 0.36, 1],
                                }}
                                style={{ originX: 0 }}
                                className="marker absolute inset-0 -z-0 rounded-sm"
                              />
                              <span className="relative z-10 px-0.5">{item.highlight}</span>
                            </span>
                            {item.q.replace(item.highlight, "")}
                          </>
                        ) : (
                          item.q
                        )}

                        {item.freq && (
                          <motion.span
                            initial={{ opacity: 0, y: 4 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: 0.35 }}
                            className="mt-1.5 inline-flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-primary"
                          >
                            ★ {item.freq}
                          </motion.span>
                        )}
                      </div>
                      <span className="shrink-0 font-mono text-xs text-muted-foreground">
                        [{item.marks}]
                      </span>
                    </motion.li>
                  ))}
                </ol>
              </motion.div>
            </AnimatePresence>

            {/* Floating 3D Parallax AI Sticky Note (Pops Out on Z-Axis) */}
            <AnimatePresence mode="wait">
              <motion.div
                key={activePaper.aiPrompt}
                initial={{ opacity: 0, y: 20, scale: 0.88, rotate: -6 }}
                animate={{ opacity: 1, y: 0, scale: 1, rotate: -3 }}
                exit={{ opacity: 0, scale: 0.9, y: 10 }}
                transition={{ type: "spring", stiffness: 320, damping: 20, delay: 0.12 }}
                style={{ transform: "translateZ(42px)" }}
                className="relative -mt-3 ml-2 max-w-[19rem] rounded-md border border-primary/50 bg-accent p-4 text-sm leading-snug text-accent-foreground shadow-[6px_6px_0_0_var(--color-border)] sm:absolute sm:-bottom-9 sm:-left-10 sm:mt-0"
              >
                <span className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-primary">
                  <Sparkles className="size-3.5 animate-pulse" />
                  Asked about this paper
                </span>
                <p className="font-semibold">{activePaper.aiPrompt}</p>
                <p className="mt-1.5 border-t border-primary/20 pt-1.5 text-xs text-muted-foreground">
                  {activePaper.aiReply}
                </p>
              </motion.div>
            </AnimatePresence>
          </motion.div>
        </motion.div>
      </section>

      {/* Infinite Brutalist Subject & Feature Marquee Strip */}
      <div className="relative z-10 overflow-hidden border-y border-border bg-primary py-3 text-primary-foreground">
        <motion.div
          animate={{ x: ["0%", "-50%"] }}
          transition={{ duration: 24, repeat: Infinity, ease: "linear" }}
          className="flex w-max items-center gap-10 whitespace-nowrap text-xs font-semibold uppercase tracking-[0.2em]"
        >
          {[...tickerItems, ...tickerItems].map((item, idx) => (
            <span key={idx} className="inline-flex items-center gap-10">
              <span>{item}</span>
              <span className="inline-block size-2 rotate-45 bg-highlight" />
            </span>
          ))}
        </motion.div>
      </div>

      {/* Tools Section with Interactive Hover Hologram Widgets */}
      <section className="relative z-10 border-b border-border bg-secondary/60">
        <div className="mx-auto max-w-6xl px-6 py-24">
          <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
            <motion.h2
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              className="max-w-2xl text-3xl sm:text-4xl"
            >
              Four things that make revision less of a scramble
            </motion.h2>
            <p className="text-sm text-muted-foreground">
              Hover any tool to inspect how it works in real time.
            </p>
          </div>

          <div className="mt-12 divide-y divide-border border-y border-border">
            {tools.map((t, idx) => {
              const Icon = t.icon;
              const isHovered = hoveredTool === t.n;

              return (
                <motion.div
                  key={t.n}
                  initial={{ opacity: 0, y: 20 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true, margin: "-40px" }}
                  transition={{
                    type: "spring",
                    stiffness: 240,
                    damping: 22,
                    delay: idx * 0.06,
                  }}
                  onMouseEnter={() => setHoveredTool(t.n)}
                  onMouseLeave={() => setHoveredTool(null)}
                  className="relative"
                >
                  {/* Shared Layout Sliding Highlight Backdrop */}
                  {isHovered && (
                    <motion.div
                      layoutId="tool-row-highlight"
                      transition={{ type: "spring", stiffness: 350, damping: 30 }}
                      className="pointer-events-none absolute inset-0 z-0 bg-card shadow-[inset_4px_0_0_0_var(--color-primary)]"
                    />
                  )}

                  <Link
                    to={t.to}
                    className="group relative z-10 grid gap-4 px-3 py-8 sm:grid-cols-[5.5rem_1fr_auto] sm:items-center sm:gap-8 sm:px-6"
                  >
                    {/* Number + Spring Icon */}
                    <div className="flex items-center gap-3">
                      <span className="font-display text-2xl text-muted-foreground/60 transition-colors group-hover:text-primary">
                        <ScrambleText text={t.n} active={isHovered} />
                      </span>
                      <motion.span
                        animate={
                          isHovered
                            ? { rotate: [0, -10, 8, 0], scale: 1.12 }
                            : { rotate: 0, scale: 1 }
                        }
                        transition={{ duration: 0.4 }}
                        className="flex size-10 items-center justify-center rounded-md border border-border bg-background text-muted-foreground shadow-[2px_2px_0_0_var(--color-border)] transition-colors group-hover:border-primary group-hover:bg-primary group-hover:text-primary-foreground"
                      >
                        <Icon className="size-4" />
                      </motion.span>
                    </div>

                    {/* Title + Body */}
                    <div>
                      <div className="flex flex-wrap items-center gap-2.5">
                        <h3 className="font-display text-xl font-semibold transition-transform duration-300 group-hover:translate-x-1">
                          {t.title}
                        </h3>
                        <span className="rounded border border-border bg-background px-2 py-0.5 font-mono text-[10px] font-semibold tracking-wider text-muted-foreground group-hover:border-primary/40 group-hover:text-primary">
                          <ScrambleText text={t.tag} active={isHovered} />
                        </span>
                      </div>
                      <p className="mt-2 max-w-xl leading-relaxed text-muted-foreground">
                        {t.body}
                      </p>
                    </div>

                    {/* Right Side: Live Pop-Up Mini Widget + CTA */}
                    <div className="flex items-center gap-5">
                      <AnimatePresence>
                        {isHovered && (
                          <motion.div
                            initial={{ opacity: 0, scale: 0.85, x: 18, rotate: 2 }}
                            animate={{ opacity: 1, scale: 1, x: 0, rotate: -1 }}
                            exit={{ opacity: 0, scale: 0.88, x: 14 }}
                            transition={{ type: "spring", stiffness: 360, damping: 24 }}
                            className="hidden lg:block"
                          >
                            <ToolLivePreview type={t.previewType} />
                          </motion.div>
                        )}
                      </AnimatePresence>

                      <span className="inline-flex shrink-0 items-center gap-1.5 text-sm font-semibold text-primary">
                        <span className="group-hover:underline">{t.cta}</span>
                        <ArrowRight className="size-4 transition-transform duration-300 group-hover:translate-x-1.5" />
                      </span>
                    </div>
                  </Link>
                </motion.div>
              );
            })}
          </div>
        </div>
      </section>

      {/* Faculty + Study Groups Animated Bento Cards */}
      <section className="relative z-10 mx-auto grid max-w-6xl gap-8 px-6 py-24 md:grid-cols-2">
        {/* Study Group Card */}
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          whileHover={{ y: -6 }}
          transition={{ type: "spring", stiffness: 260, damping: 20 }}
          className="group flex flex-col justify-between rounded-md border border-border bg-card p-8 shadow-[6px_6px_0_0_var(--color-border)] transition-shadow hover:shadow-[10px_10px_0_0_var(--color-border)]"
        >
          <div>
            <div className="mb-5 inline-flex items-center gap-2 rounded-md border border-border bg-secondary px-3 py-1 text-xs font-semibold uppercase tracking-wider text-foreground">
              <Users className="size-3.5 text-primary" />
              Multiplayer Revision
            </div>
            <h2 className="text-2xl sm:text-3xl">Studying with friends?</h2>
            <p className="mt-4 leading-relaxed text-muted-foreground">
              Start a study group, share the invite code, and see which topics the group struggles
              with. The owner can generate one shared plan and everyone gets their own copy to tick
              off.
            </p>

            {/* Animated Live Group Radar Widget */}
            <div className="mt-6 rounded-md border border-border bg-background p-4 text-xs shadow-[3px_3px_0_0_var(--color-border)]">
              <div className="flex items-center justify-between border-b border-border pb-2.5">
                <span className="font-semibold">Room: Finals-CSE-Sem5</span>
                <span className="rounded bg-highlight px-2 py-0.5 font-mono text-[11px] font-bold text-foreground">
                  CODE: CB-904
                </span>
              </div>
              <div className="mt-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Shared Weak Spot:</span>
                  <span className="font-semibold text-primary">Deadlock Avoidance (68% miss)</span>
                </div>
                <div className="flex items-center justify-between pt-1">
                  <div className="flex -space-x-1.5">
                    {["AR", "PK", "SN", "VM"].map((initials, i) => (
                      <motion.span
                        key={initials}
                        initial={{ scale: 0 }}
                        whileInView={{ scale: 1 }}
                        transition={{ delay: i * 0.08, type: "spring" }}
                        className="flex size-6 items-center justify-center rounded-full border border-border bg-secondary text-[10px] font-bold"
                      >
                        {initials}
                      </motion.span>
                    ))}
                  </div>
                  <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-primary">
                    <span className="size-2 animate-ping rounded-full bg-primary" />4 syncing plan
                  </span>
                </div>
              </div>
            </div>
          </div>

          <Link
            to="/groups"
            className="mt-7 inline-flex items-center gap-1.5 font-semibold text-primary group-hover:underline"
          >
            Set up a group
            <ArrowRight className="size-4 transition-transform group-hover:translate-x-1.5" />
          </Link>
        </motion.div>

        {/* Faculty Card */}
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          whileHover={{ y: -6 }}
          transition={{ type: "spring", stiffness: 260, damping: 20, delay: 0.08 }}
          className="group flex flex-col justify-between rounded-md border border-border bg-card p-8 shadow-[6px_6px_0_0_var(--color-border)] transition-shadow hover:shadow-[10px_10px_0_0_var(--color-border)]"
        >
          <div>
            <div className="mb-5 inline-flex items-center gap-2 rounded-md border border-border bg-secondary px-3 py-1 text-xs font-semibold uppercase tracking-wider text-foreground">
              <Sparkles className="size-3.5 text-primary" />
              For Instructors
            </div>
            <h2 className="text-2xl sm:text-3xl">Teaching a course?</h2>
            <p className="mt-4 leading-relaxed text-muted-foreground">
              Faculty accounts can upload papers as PDFs, remove their own uploads, and keep the
              semester syllabus up to date, including pasting raw syllabus text and letting AI split
              it into units.
            </p>

            {/* Animated AI Syllabus Splitter Preview */}
            <div className="mt-6 rounded-md border border-border bg-background p-4 text-xs shadow-[3px_3px_0_0_var(--color-border)]">
              <div className="flex items-center justify-between border-b border-border pb-2.5">
                <span className="font-semibold">Raw Syllabus Paste → AI Parser</span>
                <span className="font-mono text-[11px] font-semibold text-primary">
                  ✓ 5 Units Extracted
                </span>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {[
                  "Unit 1: Trees & AVL",
                  "Unit 2: Graphs",
                  "Unit 3: Hashing",
                  "Unit 4: Heaps",
                  "Unit 5: Sorting",
                ].map((u, i) => (
                  <motion.span
                    key={u}
                    initial={{ opacity: 0, scale: 0.85 }}
                    whileInView={{ opacity: 1, scale: 1 }}
                    transition={{ delay: 0.15 + i * 0.06, type: "spring" }}
                    whileHover={{ scale: 1.06, y: -2 }}
                    className="rounded border border-border bg-secondary px-2.5 py-1 text-[11px] font-medium"
                  >
                    {u}
                  </motion.span>
                ))}
              </div>
            </div>
          </div>

          <Link
            to="/syllabus"
            className="mt-7 inline-flex items-center gap-1.5 font-semibold text-primary group-hover:underline"
          >
            See the syllabus tools
            <ArrowRight className="size-4 transition-transform group-hover:translate-x-1.5" />
          </Link>
        </motion.div>
      </section>

      {/* Closing Brutalist Banner */}
      <section className="relative z-10 mx-auto max-w-6xl px-6 pb-24">
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ type: "spring", stiffness: 220, damping: 22 }}
          className="relative overflow-hidden rounded-md border border-border bg-primary px-8 py-14 text-primary-foreground shadow-[8px_8px_0_0_var(--color-border)] sm:px-14"
        >
          {/* Animated Orbiting Geometric Rings */}
          <motion.div
            aria-hidden="true"
            animate={{ rotate: 360 }}
            transition={{ duration: 36, repeat: Infinity, ease: "linear" }}
            className="pointer-events-none absolute -right-20 -top-20 size-72 rounded-full border-[22px] border-dashed border-primary-foreground/10"
          />
          <motion.div
            aria-hidden="true"
            animate={{ rotate: -360 }}
            transition={{ duration: 28, repeat: Infinity, ease: "linear" }}
            className="pointer-events-none absolute -bottom-24 right-20 size-56 rounded-full border-[14px] border-highlight/25"
          />

          <div className="relative z-10 flex flex-col justify-between gap-8 md:flex-row md:items-center">
            <div>
              <h2 className="max-w-xl text-3xl sm:text-4xl">Exams are closer than they feel.</h2>
              <p className="mt-3 max-w-lg text-primary-foreground/80">
                Start with the papers. Everything else is optional.
              </p>
            </div>

            <Magnetic strength={0.32}>
              <Link
                to="/dashboard"
                className="group inline-flex h-12 shrink-0 items-center gap-2 self-start rounded-md bg-highlight px-6 font-semibold text-foreground shadow-[4px_4px_0_0_rgba(0,0,0,0.35)] transition-all hover:-translate-y-0.5 hover:shadow-[6px_6px_0_0_rgba(0,0,0,0.45)] md:self-auto"
              >
                Browse papers
                <ArrowRight className="size-4 transition-transform duration-300 group-hover:translate-x-1.5" />
              </Link>
            </Magnetic>
          </div>
        </motion.div>
      </section>

      <footer className="relative z-10 border-t border-border bg-background">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-6 py-6 text-sm text-muted-foreground">
          <span className="font-display font-semibold text-foreground">CampusBrain</span>
          <span>Previous year papers and study tools for engineering students.</span>
        </div>
      </footer>
    </div>
  );
}
