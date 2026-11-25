import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import {
  Send,
  Loader2,
  Sparkles,
  Search,
  HelpCircle,
  BookOpen,
  BarChart3,
  PenLine,
  Layers,
  CheckCircle2,
  Brain,
  TrendingUp,
  FileText,
  Download,
  ChevronDown,
  ChevronUp,
} from "lucide-react";

import { LoginModal } from "@/components/campus/LoginModal";
import { useAuthStore } from "@/lib/auth";
import { useSharedState } from "@/lib/sharedState";
import { streamAgentChat, ApiError, type AgentEvent, type ApiMockPaper } from "@/lib/api";
import { downloadMockPaperPdf } from "@/lib/mockPaperPdf";

export const Route = createFileRoute("/_layout/agent")({
  head: () => ({ meta: [{ title: "AI Coach — CampusBrain" }] }),
  component: AgentPage,
});

/* ───────────────────────── types & helpers ───────────────────────── */

type ToolItem = {
  kind: "tool";
  id: string;
  name: string;
  args: string;
  /** undefined while the tool is still running */
  result?: string;
  turn: number;
};

type AgentItem = {
  kind: "agent";
  content: string;
  /** true while tokens are still arriving */
  streaming?: boolean;
  turn: number;
};

type PaperItem = { kind: "paper"; paper: ApiMockPaper; turn: number };

type ChatItem = { kind: "user"; content: string } | AgentItem | ToolItem | PaperItem;

const TOOL_META: Record<string, { icon: typeof Search; label: string }> = {
  search_textbook_notes: { icon: BookOpen, label: "Searching your textbook notes" },
  search_papers: { icon: Search, label: "Searching papers" },
  search_questions: { icon: HelpCircle, label: "Finding past questions" },
  get_common_topics: { icon: TrendingUp, label: "Analysing common topics" },
  build_mock_paper: { icon: FileText, label: "Building mock paper" },
  get_syllabus: { icon: BookOpen, label: "Looking up syllabus" },
  get_mcq_history: { icon: BarChart3, label: "Checking quiz history" },
  generate_mcq: { icon: PenLine, label: "Creating practice quiz" },
  generate_flashcards: { icon: Layers, label: "Creating flashcards" },
  list_papers: { icon: FileText, label: "Listing available papers" },
  get_paper_questions: { icon: HelpCircle, label: "Fetching paper questions" },
  answer_question: { icon: Brain, label: "Writing model answer" },
};

const SUGGESTIONS = [
  "Explain a topic using my saved textbook notes",
  "What are the most common topics in my past papers?",
  "Find past questions about binary trees",
  "Create a 50-mark mock paper for my first subject",
  "Make flashcards for my weakest topics",
];

function summarizeToolResult(result: string): string {
  try {
    const parsed = JSON.parse(result);
    if (Array.isArray(parsed)) return `${parsed.length} item${parsed.length !== 1 ? "s" : ""}`;
    if (Array.isArray(parsed?.topics) && parsed.subject)
      return `${parsed.topics.length} topics ranked`;
    if (parsed?.message) return String(parsed.message).slice(0, 120);
    if (parsed?.questions) return `${parsed.questions.length} questions`;
    if (parsed?.cards) return `${parsed.cards.length} flashcards`;
    return "Done";
  } catch {
    return result.slice(0, 80);
  }
}

function summarizeToolArgs(args: string): string {
  try {
    const a = JSON.parse(args);
    return a.topic || (Array.isArray(a.topics) ? a.topics.join(", ") : "") || "";
  } catch {
    return "";
  }
}

const ORIGIN_BADGE = {
  pyq: "Past paper",
  variant: "Variant",
  new: "New",
} as const;

function MockPaperCard({ paper }: { paper: ApiMockPaper }) {
  const [open, setOpen] = useState(false);
  const total = paper.sections.reduce((n, s) => n + s.questions.length, 0);
  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 p-4">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent text-primary">
          <FileText className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-foreground">{paper.title}</p>
          <p className="text-xs text-muted-foreground">
            {total} questions · {paper.totalMarks} marks · {paper.durationMinutes} min
          </p>
        </div>
        <button onClick={() => setOpen((o) => !o)} className="btn btn-outline btn-sm">
          {open ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
          {open ? "Hide" : "Preview"}
        </button>
        <button onClick={() => downloadMockPaperPdf(paper)} className="btn btn-primary btn-sm">
          <Download className="size-3.5" />
          Download PDF
        </button>
      </div>
      {open && (
        <div className="space-y-5 border-t border-border bg-muted/30 p-5 text-sm">
          {paper.sections.map((sec) => (
            <div key={sec.name}>
              <p className="page-eyebrow">{sec.name}</p>
              <ol className="mt-2 space-y-2.5">
                {sec.questions.map((q) => (
                  <li key={q.no} className="flex gap-2">
                    <span className="shrink-0 font-semibold text-foreground">Q{q.no}.</span>
                    <div className="min-w-0 flex-1">
                      <p className="text-foreground">{q.text}</p>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        {q.topic} · {ORIGIN_BADGE[q.origin]}
                        {q.source ? ` (${q.source})` : ""}
                      </p>
                    </div>
                    <span className="shrink-0 text-xs font-semibold text-foreground">
                      [{q.marks}]
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** If the last item is this turn's in-progress answer text, remove it. */
function dropStreamingTail(items: ChatItem[], turn: number): ChatItem[] {
  const last = items[items.length - 1];
  if (last && last.kind === "agent" && last.streaming && last.turn === turn) {
    return items.slice(0, -1);
  }
  return items;
}

/* ───────────────────────── markdown ───────────────────────── */

// Styled by hand so this works without the Tailwind typography plugin.
const mdComponents: Components = {
  h1: ({ children }) => (
    <h3 className="mb-1.5 mt-3 text-base font-semibold first:mt-0">{children}</h3>
  ),
  h2: ({ children }) => (
    <h3 className="mb-1.5 mt-3 text-base font-semibold first:mt-0">{children}</h3>
  ),
  h3: ({ children }) => <h4 className="mb-1 mt-3 text-sm font-semibold first:mt-0">{children}</h4>,
  h4: ({ children }) => <h4 className="mb-1 mt-2 text-sm font-semibold first:mt-0">{children}</h4>,
  p: ({ children }) => <p className="my-2 leading-relaxed first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-primary underline underline-offset-2"
    >
      {children}
    </a>
  ),
  hr: () => <hr className="my-3 border-border" />,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-border pl-3 text-muted-foreground">
      {children}
    </blockquote>
  ),
  code: ({ children, className }) =>
    className ? (
      <code className={className}>{children}</code>
    ) : (
      <code className="rounded bg-muted px-1 py-0.5 text-[0.85em]">{children}</code>
    ),
  pre: ({ children }) => (
    <pre className="my-2 overflow-x-auto rounded-md bg-muted p-3 text-xs">{children}</pre>
  ),
  // Tables scroll sideways inside the bubble instead of breaking the layout.
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-border bg-muted px-2 py-1 text-left font-semibold">{children}</th>
  ),
  td: ({ children }) => <td className="border border-border px-2 py-1 align-top">{children}</td>,
};

function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      components={mdComponents}
    >
      {children}
    </ReactMarkdown>
  );
}

/* ───────────────────────── page ───────────────────────── */

// Module-level so turn numbers stay unique even after the page remounts.
let turnCounter = 0;
const EMPTY_ITEMS: ChatItem[] = [];
const EMPTY_HISTORY: { role: "user" | "assistant"; content: string }[] = [];

function AgentPage() {
  const { user } = useAuthStore();
  const [loginOpen, setLoginOpen] = useState(false);

  // Kept in a module-level store (keyed per user) so the conversation survives tab switches.
  const chatKey = `agent:${user?.id ?? "anon"}`;
  const [chatItems, setChatItems] = useSharedState<ChatItem[]>(`${chatKey}:items`, EMPTY_ITEMS);
  const [history, setHistory] = useSharedState<{ role: "user" | "assistant"; content: string }[]>(
    `${chatKey}:history`,
    EMPTY_HISTORY,
  );
  const [input, setInput] = useSharedState(`${chatKey}:input`, "");
  const [loading, setLoading] = useSharedState(`${chatKey}:loading`, false);
  const [error, setError] = useSharedState<string | null>(`${chatKey}:error`, null);

  const messagesRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll to bottom on new content ("auto" while streaming avoids jitter)
  useEffect(() => {
    messagesRef.current?.scrollTo({
      top: messagesRef.current.scrollHeight,
      behavior: loading ? "auto" : "smooth",
    });
  }, [chatItems, loading]);

  async function sendMessage(text: string) {
    if (!text.trim() || loading) return;

    setError(null);
    setInput("");

    const userMsg = text.trim();
    const turn = ++turnCounter;
    setChatItems((prev) => [...prev, { kind: "user", content: userMsg }]);
    setHistory((prev) => [...prev, { role: "user", content: userMsg }]);
    setLoading(true);

    let finalContent = ""; // authoritative text from the "message" event
    let streamed = ""; // fallback: text accumulated from tokens

    try {
      await streamAgentChat(userMsg, history, (event: AgentEvent) => {
        switch (event.type) {
          case "token": {
            const delta = event.content ?? "";
            if (!delta) break;
            streamed += delta;
            setChatItems((prev) => {
              const last = prev[prev.length - 1];
              if (last && last.kind === "agent" && last.streaming && last.turn === turn) {
                return [...prev.slice(0, -1), { ...last, content: last.content + delta }];
              }
              return [...prev, { kind: "agent", content: delta, streaming: true, turn }];
            });
            break;
          }

          case "tool_call": {
            // Any text streamed before a tool call was "thinking out loud"; hide it.
            streamed = "";
            const id = event.id ?? `${event.name ?? "tool"}-${Date.now()}-${Math.random()}`;
            setChatItems((prev) => [
              ...dropStreamingTail(prev, turn),
              { kind: "tool", id, name: event.name ?? "tool", args: event.args ?? "", turn },
            ]);
            break;
          }

          case "tool_result": {
            setChatItems((prev) => {
              const idx = prev.findIndex(
                (it) =>
                  it.kind === "tool" &&
                  it.turn === turn &&
                  (event.id
                    ? it.id === event.id
                    : it.name === event.name && it.result === undefined),
              );
              if (idx === -1) return prev;
              const copy = [...prev];
              copy[idx] = { ...(copy[idx] as ToolItem), result: event.result ?? "" };
              return copy;
            });
            break;
          }

          case "message": {
            if (!event.content) break;
            finalContent = event.content;
            const content = event.content;
            setChatItems((prev) => {
              const last = prev[prev.length - 1];
              if (last && last.kind === "agent" && last.streaming && last.turn === turn) {
                return [...prev.slice(0, -1), { kind: "agent", content, turn }];
              }
              return [...prev, { kind: "agent", content, turn }];
            });
            break;
          }

          case "artifact": {
            const artifact = event.artifact;
            if (artifact?.kind === "mock_paper") {
              setChatItems((prev) => [
                ...dropStreamingTail(prev, turn),
                { kind: "paper", paper: artifact.paper, turn },
              ]);
            }
            break;
          }

          // Backend is retrying (rate limit / bad tool call): discard this turn's partial output.
          case "retry": {
            finalContent = "";
            streamed = "";
            setChatItems((prev) => prev.filter((it) => it.kind === "user" || it.turn !== turn));
            break;
          }

          case "error":
            setError(event.message ?? "An error occurred");
            break;

          case "done":
            break;
        }
      });

      const answer = finalContent || streamed;
      if (answer) {
        setHistory((prev) => [...prev, { role: "assistant", content: answer }]);
      }
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Failed to connect to the AI agent.";
      setError(msg);
    } finally {
      // Make sure no bubble is left in the "streaming" state.
      setChatItems((prev) =>
        prev.map((it) => (it.kind === "agent" && it.streaming ? { ...it, streaming: false } : it)),
      );
      setLoading(false);
      inputRef.current?.focus();
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    void sendMessage(input);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void sendMessage(input);
    }
  }

  // ── Not logged in ──
  if (!user) {
    return (
      <main className="mx-auto flex max-w-md flex-col items-center px-6 py-24 text-center">
        <div className="flex size-14 items-center justify-center rounded-full bg-accent text-primary">
          <Brain className="size-7" />
        </div>
        <h1 className="mt-4 text-2xl font-bold tracking-tight text-foreground">AI Study Coach</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Sign in to chat with your AI study coach — it can search past papers, find questions, and
          create quizzes and flashcards for you.
        </p>
        <button onClick={() => setLoginOpen(true)} className="btn btn-primary mt-6 px-6">
          Sign In
        </button>
        <LoginModal
          open={loginOpen}
          onClose={() => setLoginOpen(false)}
          onSuccess={() => setLoginOpen(false)}
        />
      </main>
    );
  }

  const lastItem = chatItems[chatItems.length - 1];
  const showThinking = loading && !(lastItem && lastItem.kind === "agent" && lastItem.streaming);

  return (
    <main className="mx-auto flex h-[calc(100vh-7.25rem)] max-w-3xl flex-col px-4">
      {/* Header */}
      <div className="flex items-center gap-3 py-4">
        <span className="flex size-10 items-center justify-center rounded-full bg-accent text-primary">
          <Sparkles className="size-5" />
        </span>
        <div>
          <h1 className="text-lg font-bold tracking-tight text-foreground">AI Study Coach</h1>
          <p className="text-xs text-muted-foreground">
            Finds common topics & past questions, builds mock papers, quizzes & flashcards
          </p>
        </div>
      </div>

      {/* Messages */}
      <div ref={messagesRef} className="chat-scroll flex-1 space-y-3 overflow-y-auto pb-4 pr-3">
        {chatItems.length === 0 && !loading && (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <div className="flex size-12 items-center justify-center rounded-full bg-accent text-primary">
              <Sparkles className="size-6" />
            </div>
            <p className="mt-4 text-base font-semibold text-foreground">
              Ask me anything about your studies
            </p>
            <p className="mt-1 max-w-md text-sm text-muted-foreground">
              I can rank your most-asked topics, find past questions, build a mock paper PDF, and
              create quizzes and flashcards.
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => void sendMessage(s)}
                  className="chip transition-colors hover:border-primary hover:text-primary"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {chatItems.map((item, i) => {
          if (item.kind === "user") {
            return (
              <div key={i} className="flex justify-end">
                <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-sm shadow-sm text-primary-foreground">
                  {item.content}
                </div>
              </div>
            );
          }

          if (item.kind === "agent") {
            return (
              <div key={i} className="flex justify-start">
                <div className="min-w-0 max-w-[85%] card rounded-2xl rounded-bl-md px-4 py-3 text-sm text-foreground">
                  <Markdown>{item.content}</Markdown>
                </div>
              </div>
            );
          }

          if (item.kind === "paper") {
            return <MockPaperCard key={`paper-${i}`} paper={item.paper} />;
          }

          // tool: one row showing the call and, once finished, its result
          const meta = TOOL_META[item.name] ?? { icon: Search, label: item.name };
          const Icon = meta.icon;
          const argSummary = summarizeToolArgs(item.args);
          const done = item.result !== undefined;
          return (
            <div
              key={item.id}
              className="w-fit max-w-full rounded-2xl bg-muted/60 px-3 py-1.5 text-xs text-muted-foreground"
            >
              <div className="flex items-center gap-2">
                <Icon className="size-3.5 shrink-0 text-primary" />
                <span>{meta.label}</span>
                {argSummary && (
                  <span className="truncate text-muted-foreground/70">{argSummary}</span>
                )}
                <span className="ml-auto shrink-0">
                  {done ? (
                    <CheckCircle2 className="size-3.5 text-emerald-600 dark:text-emerald-400" />
                  ) : (
                    <Loader2 className="size-3.5 animate-spin" />
                  )}
                </span>
              </div>
              {done && (
                <p className="mt-0.5 pl-5 text-muted-foreground/80">
                  {summarizeToolResult(item.result!)}
                </p>
              )}
            </div>
          );
        })}

        {/* Loading indicator (hidden once the answer starts streaming) */}
        {showThinking && (
          <div className="flex items-center gap-2 pl-1 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            <span>Thinking…</span>
          </div>
        )}

        {error && (
          <p className="rounded-xl bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>
        )}
      </div>

      {/* Input */}
      <div className="border-t border-border py-4">
        <form onSubmit={handleSubmit} className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask your AI coach anything…"
            rows={1}
            disabled={loading}
            className="field max-h-32 flex-1 resize-none disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={loading || !input.trim()}
            className="btn btn-primary shrink-0"
          >
            {loading ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
            Send
          </button>
        </form>
        <p className="mt-1.5 text-center text-[10px] text-muted-foreground/60">
          The coach searches your papers and creates study materials. It may take a few seconds.
        </p>
      </div>
    </main>
  );
}
