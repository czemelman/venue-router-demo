export class ApiError extends Error {
  constructor(message: string, public body: any) { super(message); }
}

export async function api<T = any>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init?.method ?? (init?.body !== undefined ? "POST" : "GET"),
    // only declare JSON when there is a body: the server rejects an empty body with a JSON content-type
    headers: init?.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = body.details ? " " + JSON.stringify(body.details).slice(0, 300) : "";
    throw new ApiError((body.error ?? res.statusText) + detail, body);
  }
  return body as T;
}
