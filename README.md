# soapnoteapi-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server for **[SOAPNoteAPI](https://www.soapnoteapi.com)**. It lets AI agents (Claude Desktop/Code, Cursor, Windsurf, VS Code + Copilot, etc.) turn clinical transcripts or audio recordings into structured **SOAP notes**, **ICD-10/CPT billing-code suggestions**, **patient summaries**, and **visit summaries**.

> ⚕️ All clinical content and billing codes are **AI-generated decision support** and must be reviewed by a qualified clinician/coder before use. HIPAA: this server only transits PHI to the API over TLS and never logs note content.

## Tools

| Tool | What it does | API |
|------|--------------|-----|
| `list_specialties` | List supported specialties (no key needed) | `GET /v1/specialties` |
| `generate_soap_note` | Transcript → SOAP note (+ optional billing codes, patient summary) | `POST /v1/note` |
| `get_note` | Fetch a note by `noteId` | `GET /v1/note/{id}` |
| `summarize_visits` | Consolidate visits into a longitudinal summary | `POST /v1/visit-summary` |
| `transcribe_audio_to_soap` | Local audio file → SOAP note (waits for async jobs) | `PUT /v1/note/audio` |
| `get_audio_status` | Poll an async audio job | `GET /v1/audio/status/{id}` |

## Setup

Get an API key at <https://app.soapnoteapi.com> (free tier: $10 credit, first 20 notes free).

### Claude Desktop / Cursor (`mcp.json`)

```json
{
  "mcpServers": {
    "soapnoteapi": {
      "command": "npx",
      "args": ["-y", "soapnoteapi-mcp"],
      "env": { "SOAPNOTEAPI_KEY": "snapi_sk_live_xxxxxxxx" }
    }
  }
}
```

### Claude Code

```bash
claude mcp add soapnoteapi --env SOAPNOTEAPI_KEY=snapi_sk_live_xxxxxxxx -- npx -y soapnoteapi-mcp
```

## Environment variables

| Variable | Required | Notes |
|----------|----------|-------|
| `SOAPNOTEAPI_KEY` | yes (for all tools except `list_specialties`) | Bearer key, `snapi_sk_live_…` or `snapi_sk_test_…` |
| `SOAPNOTEAPI_BASE_URL` | no | Override API base (default `https://api.soapnoteapi.com`) |

## Develop

```bash
pnpm install
pnpm --filter soapnoteapi-mcp dev     # run from source (tsx)
pnpm --filter soapnoteapi-mcp build   # compile to dist/
npx @modelcontextprotocol/inspector node dist/index.js   # interactive test
```

## Publish

```bash
pnpm --filter soapnoteapi-mcp build
cd packages/mcp && npm publish        # publishes soapnoteapi-mcp to npm
```

## License

MIT
