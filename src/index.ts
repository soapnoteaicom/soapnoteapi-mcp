#!/usr/bin/env node
/**
 * SOAPNoteAPI — Model Context Protocol (MCP) server.
 *
 * Exposes the SOAPNoteAPI REST endpoints as MCP tools so AI agents (Claude
 * Desktop/Code, Cursor, etc.) can generate clinical SOAP notes, billing-code
 * suggestions, patient summaries and visit summaries from transcripts or audio.
 *
 * Transport: stdio. Auth: SOAPNOTEAPI_KEY environment variable (Bearer token).
 *
 * HIPAA / stdio rules:
 *   - A stdio MCP server MUST write nothing but protocol messages to stdout.
 *     All diagnostics go to stderr (console.error) only.
 *   - Never log transcripts, audio, patient context, or generated note bodies.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { SoapNoteApiClient, SoapNoteApiError } from "./client.js";

/** The 24 specialties accepted by the API (GET /v1/specialties returns the live list). */
const SPECIALTIES = [
  "nurse_practitioner",
  "physician",
  "psychiatrist",
  "psychotherapist",
  "physical_therapy",
  "occupational_therapy",
  "chiropractor",
  "dentist",
  "acupuncture",
  "social_worker",
  "registered_nurse",
  "slp",
  "veterinary",
  "massage_therapy",
  "pharmacy",
  "podiatrist",
  "dietitian_nutritionist",
  "athletic_trainer",
  "aroma_therapy",
  "exercise_therapy",
  "ems",
  "paramedic",
  "genetic_counselling",
  "generic",
] as const;

const API_KEY = process.env["SOAPNOTEAPI_KEY"] ?? process.env["SOAPNOTEAPI_API_KEY"] ?? "";
const BASE_URL = process.env["SOAPNOTEAPI_BASE_URL"];

const client = new SoapNoteApiClient({ apiKey: API_KEY, baseUrl: BASE_URL });

// ── helpers ──────────────────────────────────────────────────────────────────

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function ok(data: unknown): ToolResult {
  return {
    content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
  };
}

function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (e) {
    if (e instanceof SoapNoteApiError) {
      if (e.code === "AUTHENTICATION_ERROR" || e.status === 401) {
        return fail(
          "Authentication failed. Set SOAPNOTEAPI_KEY to a valid key (snapi_sk_live_… / snapi_sk_test_…) from https://app.soapnoteapi.com.",
        );
      }
      return fail(`SOAPNoteAPI error [${e.code}] (HTTP ${e.status}): ${e.message}`);
    }
    // Avoid surfacing anything that could contain PHI; report only the message.
    return fail(e instanceof Error ? e.message : String(e));
  }
}

function requireKey(): void {
  if (!client.hasKey) {
    throw new SoapNoteApiError(401, "AUTHENTICATION_ERROR", "Missing API key.");
  }
}

// ── BAA reminder (warn, never block) ───────────────────────────────────────────
// A BAA is a legal agreement between organizations, executed via SOAPNoteAPI's
// white-glove process — the client deliberately does NOT block or gate PHI. We
// only surface a one-time, non-blocking reminder on the first PHI-bearing call.
const BAA_NOTICE =
  "\n\n⚠️ BAA reminder: For real production workloads containing PHI, your organization " +
  "must have an executed Business Associate Agreement (BAA) with SOAPNoteAPI. Test/sandbox " +
  "keys are for non-PHI evaluation. Arrange a BAA at https://soapnoteapi.com/security/. " +
  "(Reminder only — this does not restrict your request.)";
let baaNoticeShown = false;
function withBaaNotice(result: ToolResult): ToolResult {
  if (baaNoticeShown) return result;
  baaNoticeShown = true;
  return { ...result, content: [...result.content, { type: "text", text: BAA_NOTICE }] };
}
// Wrapper for PHI-bearing tools: runs normally, then appends the one-time reminder.
async function runPhi(fn: () => Promise<unknown>): Promise<ToolResult> {
  return withBaaNotice(await run(fn));
}

// Reusable optional patient-context shape (maps to the API's context.patient_info).
const patientShape = z
  .object({
    name: z.string().optional(),
    age: z.number().int().positive().optional(),
    gender: z.string().optional(),
    medical_history: z.string().optional(),
    medications: z.array(z.string()).optional(),
    allergies: z.array(z.string()).optional(),
  })
  .optional()
  .describe("Optional patient demographics & history to enrich the note.");

function buildContext(opts: {
  patient?: Record<string, unknown>;
  patient_history?: string;
  custom_instructions?: string;
}): Record<string, unknown> | undefined {
  const ctx: Record<string, unknown> = {};
  if (opts.patient && Object.keys(opts.patient).length) ctx["patient_info"] = opts.patient;
  if (opts.patient_history) ctx["patient_history"] = opts.patient_history;
  if (opts.custom_instructions) ctx["custom_instructions"] = opts.custom_instructions;
  return Object.keys(ctx).length ? ctx : undefined;
}

function omitUndefined<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── server ───────────────────────────────────────────────────────────────────

const server = new McpServer(
  { name: "soapnoteapi-mcp", version: "0.1.1" },
  {
    instructions:
      "Tools for SOAPNoteAPI (https://www.soapnoteapi.com): generate structured clinical SOAP " +
      "notes, ICD-10/CPT billing-code suggestions, patient summaries, and longitudinal visit " +
      "summaries from clinical transcripts or audio recordings. All billing codes and clinical " +
      "content are AI-generated decision support and require review by a qualified clinician/coder " +
      "before use. For real production workloads containing PHI, your organization must have an " +
      "executed BAA with SOAPNoteAPI (arrange at https://soapnoteapi.com/security/); test/sandbox " +
      "keys are for non-PHI evaluation. Call list_specialties to see valid specialty values.",
  },
);

server.registerTool(
  "list_specialties",
  {
    title: "List medical specialties",
    description:
      "List the medical specialties (and template variants) supported by SOAPNoteAPI. " +
      "Use the returned specialty IDs as the `specialty` argument for note generation. No API key required.",
    inputSchema: {},
  },
  async () => run(() => client.listSpecialties()),
);

server.registerTool(
  "generate_soap_note",
  {
    title: "Generate SOAP note from transcript",
    description:
      "Generate a structured SOAP note (Subjective, Objective, Assessment, Plan) from a clinical " +
      "transcript or shorthand. Optionally returns ICD-10/CPT/HCPCS billing-code suggestions and a " +
      "plain-language patient summary. Billing codes are AI decision support and require clinician review.",
    inputSchema: {
      transcript: z
        .string()
        .min(50)
        .describe("Clinical transcript or shorthand to expand into a SOAP note (min ~50 characters)."),
      specialty: z.enum(SPECIALTIES).describe("Medical specialty. Call list_specialties for the full list."),
      template: z.string().optional().describe('Optional template within the specialty (default "standard").'),
      include_billing_codes: z.boolean().optional().describe("Return ICD-10/CPT/HCPCS billing-code suggestions."),
      include_patient_summary: z.boolean().optional().describe("Return a plain-language patient-facing summary."),
      include_icd11: z.boolean().optional().describe("Also return advisory ICD-11 codes (not for US billing)."),
      custom_instructions: z.string().optional().describe("Free-text instructions to steer formatting/content."),
      patient: patientShape,
      patient_history: z.string().optional().describe("Free-text prior history to enrich the note."),
    },
  },
  async (args) => {
    return runPhi(() => {
      requireKey();
      const body = omitUndefined({
        transcript: args.transcript,
        specialty: args.specialty,
        template: args.template,
        include_billing_codes: args.include_billing_codes,
        include_patient_summary: args.include_patient_summary,
        include_icd11: args.include_icd11,
        context: buildContext(args),
      });
      return client.generateNote(body);
    });
  },
);

server.registerTool(
  "get_note",
  {
    title: "Retrieve a generated note",
    description:
      "Retrieve a previously generated note by its noteId. Useful for fetching the result of an " +
      "asynchronous audio job once status is 'completed'. Notes auto-expire (see expires_at).",
    inputSchema: {
      noteId: z.string().describe("The noteId returned by a generate/audio call (e.g. note_01jfg…)."),
    },
  },
  async ({ noteId }) =>
    run(() => {
      requireKey();
      return client.getNote(noteId);
    }),
);

server.registerTool(
  "summarize_visits",
  {
    title: "Summarize visit history",
    description:
      "Consolidate multiple past visits (SOAP notes and/or free-text summaries) into a longitudinal " +
      "summary with key findings and active diagnoses. Useful for care coordination and chart prep.",
    inputSchema: {
      visits: z
        .array(
          z.object({
            visit_date: z.string().describe("ISO 8601 date of the visit."),
            provider: z.string().optional(),
            soap_note: z
              .object({
                subjective: z.string().optional(),
                objective: z.string().optional(),
                assessment: z.string().optional(),
                plan: z.string().optional(),
              })
              .optional()
              .describe("Structured SOAP note for the visit (provide this OR summary)."),
            summary: z.string().optional().describe("Free-text visit summary (provide this OR soap_note)."),
          }),
        )
        .min(1)
        .describe("Chronological list of prior visits. Each needs a soap_note or a summary."),
      patient: patientShape,
      focus: z.string().optional().describe("Optional focus area to bias the summary (e.g. 'diabetes management')."),
    },
  },
  async (args) =>
    runPhi(() => {
      requireKey();
      const body = omitUndefined({
        visits: args.visits,
        patient_info: args.patient,
        focus: args.focus,
      });
      return client.summarizeVisits(body);
    }),
);

server.registerTool(
  "transcribe_audio_to_soap",
  {
    title: "Audio recording → SOAP note",
    description:
      "Upload a local audio recording of a clinical encounter and get back a SOAP note. Short " +
      "recordings return immediately; long ones process asynchronously — by default this tool waits " +
      "and returns the finished note. Supported: mp3, m4a, wav, ogg, webm, flac.",
    inputSchema: {
      audio_path: z.string().describe("Absolute path to a local audio file (mp3/m4a/wav/ogg/webm/flac)."),
      specialty: z.enum(SPECIALTIES).describe("Medical specialty. Call list_specialties for the full list."),
      template: z.string().optional(),
      include_billing_codes: z.boolean().optional(),
      include_patient_summary: z.boolean().optional(),
      include_icd11: z.boolean().optional(),
      include_transcript: z.boolean().optional().describe("Return the diarized, timestamped transcript."),
      custom_instructions: z.string().optional(),
      patient: patientShape,
      patient_history: z.string().optional(),
      wait_for_completion: z
        .boolean()
        .optional()
        .default(true)
        .describe("If true (default), poll until the note is ready for long async recordings."),
      timeout_seconds: z
        .number()
        .int()
        .positive()
        .optional()
        .default(300)
        .describe("Max seconds to wait when polling an async job (default 300)."),
    },
  },
  async (args) =>
    runPhi(async () => {
      requireKey();
      const metadata = omitUndefined({
        specialty: args.specialty,
        template: args.template,
        include_billing_codes: args.include_billing_codes,
        include_patient_summary: args.include_patient_summary,
        include_icd11: args.include_icd11,
        include_transcript: args.include_transcript,
        context: buildContext(args),
      });

      const { status, data } = await client.uploadAudio(args.audio_path, metadata);

      // 200 = synchronous note ready; 202 = async job accepted.
      if (status !== 202) return data;

      const noteId = data.noteId;
      if (!noteId) return data;
      if (!args.wait_for_completion) return data;

      const deadline = Date.now() + args.timeout_seconds * 1000;
      const intervalMs = 5000;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        await sleep(intervalMs);
        const st = await client.audioStatus(noteId);
        const s = (st.status ?? "").toLowerCase();
        if (s === "completed") return client.getNote(noteId);
        if (s === "failed") {
          throw new SoapNoteApiError(500, "AUDIO_FAILED", "Audio processing failed.", st);
        }
        if (Date.now() > deadline) {
          return {
            noteId,
            status: s || "processing",
            message: `Still processing after ${args.timeout_seconds}s. Poll get_audio_status / get_note with noteId "${noteId}".`,
          };
        }
      }
    }),
);

server.registerTool(
  "get_audio_status",
  {
    title: "Check audio job status",
    description: "Check the processing status of an asynchronous audio-to-SOAP job by noteId.",
    inputSchema: {
      noteId: z.string().describe("The noteId returned by transcribe_audio_to_soap for a long recording."),
    },
  },
  async ({ noteId }) =>
    run(() => {
      requireKey();
      return client.audioStatus(noteId);
    }),
);

// ── start ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr only — never stdout (stdout is the MCP protocol channel).
  console.error(
    `soapnoteapi-mcp ready (base=${BASE_URL ?? "https://api.soapnoteapi.com"}, key=${client.hasKey ? "set" : "MISSING"})`,
  );
  console.error(
    "Reminder: process PHI only under an executed BAA with SOAPNoteAPI. Test keys are for non-PHI evaluation. https://soapnoteapi.com/security/",
  );
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
