/** Exact origins only: a shared hosting suffix is not a trust boundary. */
export function allowedOrigins(
  frontendUrl: string,
  extra = "",
  development = false,
): Set<string> {
  const origins = [
    frontendUrl,
    ...extra
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  ];
  if (development)
    origins.push("http://localhost:3000", "http://localhost:8080");
  return new Set(
    origins.map((value) => {
      const url = new URL(value);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash
      ) {
        throw new Error(`Invalid CORS origin: ${value}`);
      }
      return url.origin;
    }),
  );
}
