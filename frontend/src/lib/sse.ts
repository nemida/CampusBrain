/** Read JSON server-sent events, including split UTF-8, CRLF and a final partial line. */
export async function readJsonEventStream<T>(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: T) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];

  const dispatch = () => {
    if (!data.length) return;
    const payload = data.join("\n");
    data = [];
    let event: T;
    try {
      event = JSON.parse(payload) as T;
    } catch {
      return;
    } // A malformed event must not discard subsequent valid events.
    onEvent(event); // Consumer failures must propagate, rather than disappear as parse errors.
  };
  const line = (value: string) => {
    value = value.replace(/\r$/, "");
    if (value === "") dispatch();
    else if (value.startsWith("data:")) data.push(value.slice(5).replace(/^ /, ""));
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      lines.forEach(line);
      if (done) {
        if (buffer) line(buffer);
        dispatch();
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
