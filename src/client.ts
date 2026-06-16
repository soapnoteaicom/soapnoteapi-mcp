/**
 * Thin REST client for the SOAPNoteAPI (https://api.soapnoteapi.com).
 *
 * HIPAA: this client only TRANSITS protected health information (transcripts,
 * patient context) to the API over TLS. It must NEVER log request or response
 * bodies. Callers must also avoid writing PHI to stdout/stderr.
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

export interface SoapNoteApiOptions {
  /** API key (snapi_sk_live_… or snapi_sk_test_…). May be empty for public endpoints. */
  apiKey: string;
  /** Override the API base URL (defaults to https://api.soapnoteapi.com). */
  baseUrl?: string;
}

/** Structured error mirroring the API's `{ error: { code, message, details } }` envelope. */
export class SoapNoteApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "SoapNoteApiError";
  }
}

const DEFAULT_BASE_URL = "https://api.soapnoteapi.com";

export class SoapNoteApiClient {
  private readonly baseUrl: string;

  constructor(private readonly opts: SoapNoteApiOptions) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  get hasKey(): boolean {
    return Boolean(this.opts.apiKey);
  }

  private authHeaders(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = { ...extra };
    if (this.opts.apiKey) headers["Authorization"] = `Bearer ${this.opts.apiKey}`;
    return headers;
  }

  private async parse<T>(res: Response): Promise<T> {
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (!res.ok) {
      const err = (json as { error?: { code?: string; message?: string; details?: unknown } })?.error ?? {};
      throw new SoapNoteApiError(
        res.status,
        err.code ?? `HTTP_${res.status}`,
        err.message ?? `Request failed with status ${res.status}`,
        err.details,
      );
    }
    return json as T;
  }

  private async requestJson<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.authHeaders(body !== undefined ? { "Content-Type": "application/json" } : undefined),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return this.parse<T>(res);
  }

  /** GET /v1/specialties — public, no auth required. */
  listSpecialties(): Promise<unknown> {
    return this.requestJson("GET", "/v1/specialties");
  }

  /** POST /v1/note — generate a SOAP note from a text transcript. */
  generateNote(body: unknown): Promise<unknown> {
    return this.requestJson("POST", "/v1/note", body);
  }

  /** GET /v1/note/{noteId} — retrieve a previously generated note. */
  getNote(noteId: string): Promise<unknown> {
    return this.requestJson("GET", `/v1/note/${encodeURIComponent(noteId)}`);
  }

  /** POST /v1/visit-summary — consolidate multiple visits into a longitudinal summary. */
  summarizeVisits(body: unknown): Promise<unknown> {
    return this.requestJson("POST", "/v1/visit-summary", body);
  }

  /** GET /v1/audio/status/{noteId} — poll async audio processing status. */
  audioStatus(noteId: string): Promise<{ status?: string; [k: string]: unknown }> {
    return this.requestJson("GET", `/v1/audio/status/${encodeURIComponent(noteId)}`);
  }

  /**
   * PUT /v1/note/audio — multipart upload of an audio file plus a JSON metadata part.
   * Returns the HTTP status so callers can distinguish 200 (note ready) from 202 (async).
   */
  async uploadAudio(
    filePath: string,
    metadata: Record<string, unknown>,
  ): Promise<{ status: number; data: { noteId?: string; status?: string; [k: string]: unknown } }> {
    const buf = await readFile(filePath);
    const form = new FormData();
    // Buffer is a Uint8Array; wrap as a Blob part. Do NOT set Content-Type — fetch
    // sets the multipart boundary automatically.
    form.append("audio", new Blob([buf]), basename(filePath));
    form.append("metadata", JSON.stringify(metadata));
    const res = await fetch(`${this.baseUrl}/v1/note/audio`, {
      method: "PUT",
      headers: this.authHeaders(),
      body: form,
    });
    const data = await this.parse<{ noteId?: string; status?: string; [k: string]: unknown }>(res);
    return { status: res.status, data };
  }
}
