import { useQuery } from "@tanstack/react-query";
import { fetchStudyAccess } from "./api";
import { useAuthStore } from "./auth";

const studyPaths = new Set([
  "/student",
  "/textbooks",
  "/study",
  "/groups",
  "/pyq",
  "/profile",
  "/mcq",
  "/flashcards",
  "/agent",
]);

export function isStudyPath(path: string): boolean {
  return studyPaths.has(path.replace(/\/+$/, ""));
}

export function useStudyAccess() {
  const { user } = useAuthStore();
  const isAdmin = user?.role === "ADMIN";
  const policy = useQuery({
    queryKey: ["study-access"],
    queryFn: fetchStudyAccess,
    enabled: !!user && !isAdmin,
    staleTime: 30_000,
  });

  return {
    allowed: isAdmin || (!!user && policy.data?.access === "signed-in"),
    checking: !!user && !isAdmin && policy.isPending,
    unavailable: !!user && !isAdmin && policy.isError,
  };
}
