export interface User {
  id: string;
  email: string;
  displayName: string;
  role: "admin" | "user";
  mustChangePassword: boolean;
  csrfToken: string;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: "streaming" | "complete" | "error" | "cancelled";
  createdAt: string;
  runId?: string | null;
}

export interface AdminUser extends Omit<User, "csrfToken"> {
  active: boolean;
  createdAt?: string;
  lastLoginAt?: string | null;
}

export type StreamEvent =
  | { type: "status"; label: string; state: "queued" | "running" }
  | { type: "token"; delta: string }
  | { type: "trace"; label: string; state: "running" | "complete" | "error"; durationMs?: number }
  | { type: "complete"; messageId: string; content: string }
  | { type: "cancelled" }
  | { type: "error"; code: string; message: string; retryable: boolean };

let csrfToken = "";

export function setCsrf(value: string) {
  csrfToken = value;
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const method = options.method?.toUpperCase() ?? "GET";
  const response = await fetch(path, {
    credentials: "include",
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(!["GET", "HEAD"].includes(method) && csrfToken ? { "x-csrf-token": csrfToken } : {}),
      ...options.headers,
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const error = new Error(body.message ?? body.error ?? "Request failed") as Error & { code?: string; status?: number };
    error.code = body.error;
    error.status = response.status;
    throw error;
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export async function streamRun(
  runId: string,
  onEvent: (event: StreamEvent, id?: string) => void,
  signal: AbortSignal,
  lastEventId?: string,
) {
  const response = await fetch(`/api/runs/${runId}/events`, {
    credentials: "include",
    headers: lastEventId ? { "Last-Event-ID": lastEventId } : {},
    signal,
  });
  if (!response.ok || !response.body) throw new Error("Unable to connect to the response stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let latestId = lastEventId;
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("id:")) latestId = line.slice(3).trim();
        if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      if (data.length) onEvent(JSON.parse(data.join("\n")) as StreamEvent, latestId);
    }
    if (done) return latestId;
  }
}
