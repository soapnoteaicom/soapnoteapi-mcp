# Publishing & registering `soapnoteapi-mcp`

How to get this server discoverable by AI agents across the MCP directories.

## The key insight

The **official MCP registry is the master source**. Publishing there covers most of the ecosystem automatically:

| Directory | How it gets your listing | Action needed |
|-----------|--------------------------|---------------|
| **Official MCP Registry** | Direct publish (`mcp-publisher`) | ✅ Step 2 |
| **Glama** | Auto-ingests the official registry (it's a *superset*) | Step 2 + optional claim (Step 4) |
| **PulseMCP** | Mirrors the official registry (daily ingest, ~weekly processing) | Step 2 only (optional /submit to speed up) |
| **mcp.so** | Manual web form (also increasingly pulls the official registry) | Step 3 (browser) |
| **Smithery** | GitHub-connect hosted build — ⚠️ see HIPAA caveat | Step 5 (optional) |

So: **npm publish → official registry publish → one manual mcp.so form.** That's the whole job.

---

## Prerequisites (one-time)

- An **npm account** (free) — the registry stores metadata only; the package must be on npmjs.org first.
- The code in a **public GitHub repo**: `github.com/soapnoteaicom/soapnoteapi-mcp` (extract this `packages/mcp/` folder into its own repo — it's already structured as a repo root).
- **OpenSSL 3+** for the DNS keypair. macOS system `openssl` is LibreSSL and **cannot** do Ed25519 (`Algorithm Ed25519 not found`) → `brew install openssl@3` and call `/opt/homebrew/opt/openssl@3/bin/openssl`, or use the ECDSA P-384 path.
- Access to **soapnoteapi.com DNS** (to add one apex TXT record).
- `mcp-publisher` CLI: `brew install mcp-publisher` (or grab the latest release binary — an old binary fails with `invalid audience`).

---

## Step 0 — Extract to the public repo

```bash
# from the monorepo
cp -r packages/mcp /tmp/soapnoteapi-mcp && cd /tmp/soapnoteapi-mcp
git init && git add . && git commit -m "soapnoteapi-mcp v0.1.0"
gh repo create soapnoteaicom/soapnoteapi-mcp --public --source=. --push
```
Keep developing in the monorepo and sync, **or** make the new repo the source of truth — your call. The registries need the **public** repo; the production monorepo stays private.

## Step 1 — Publish to npm (must happen first)

```bash
npm run build
npm login            # if needed
npm publish --access public
# verify
open https://www.npmjs.com/package/soapnoteapi-mcp
```
> ⚠️ The `mcpName` field in `package.json` (`com.soapnoteapi/soapnoteapi-mcp`) **must already be in the published tarball** — it's how the registry proves you own the package. It is. If you ever change it, publish a new npm version.

## Step 2 — Publish to the official registry (covers Glama + PulseMCP + mcp.so-ingest)

DNS namespace auth, since you own `soapnoteapi.com`:

```bash
# 2a. generate the keypair (use OpenSSL 3 on macOS!)
openssl genpkey -algorithm Ed25519 -out key.pem
PUBLIC_KEY="$(openssl pkey -in key.pem -pubout -outform DER | tail -c 32 | base64)"
echo "soapnoteapi.com. IN TXT \"v=MCPv1; k=ed25519; p=${PUBLIC_KEY}\""
```

```text
# 2b. add that TXT record at the APEX of soapnoteapi.com (NOT under _mcp-auth or any selector)
#   host:  soapnoteapi.com        type: TXT
#   value: v=MCPv1; k=ed25519; p=<the base64 public key>
# wait for propagation (a few minutes; depends on TTL)
```

```bash
# 2c. log in and publish (server.json is already in this repo)
PRIVATE_KEY="$(openssl pkey -in key.pem -noout -text | grep -A3 'priv:' | tail -n +2 | tr -d ' :\n')"
mcp-publisher login dns --domain soapnoteapi.com --private-key "${PRIVATE_KEY}"
mcp-publisher publish
# verify
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=com.soapnoteapi/soapnoteapi-mcp"
```

> **Run `mcp-publisher init` once** to confirm `server.json` matches the CLI's current schema, then diff against the committed file. The registry is in "preview" — the `$schema` date can move.
>
> **Immutability:** published versions can never be edited or deleted. To fix anything, bump `version` in **both** `package.json` and `server.json` (keep them equal) and re-publish. No version ranges (`^1.0.0`) in `server.json`.

## Step 3 — mcp.so (manual, ~10 min, needs a browser)

mcp.so has no CLI and blocks `curl` (Cloudflare). In a browser:
1. Go to <https://mcp.so/submit>, sign in with the **GitHub account that owns the repo**.
2. Type = `server`, Name = `soapnoteapi-mcp`, URL = the **https** GitHub repo URL.
3. Paste the client config into `server_config` (use a placeholder key — the listing is public):
   ```json
   {"mcpServers":{"soapnoteapi":{"command":"npx","args":["-y","soapnoteapi-mcp"],"env":{"SOAPNOTEAPI_KEY":"<your-key>"}}}}
   ```
4. Leave `is_dxt` off. Submit → you're redirected to `/my-servers/{uuid}/edit` → fill description, icon, and tags (`healthcare`, `clinical`, `soap-notes`, `medical`). Save.

## Step 4 — Glama claim (optional; improves your quality score)

You're auto-listed via Step 2, but claim it for control + a better score:
1. `glama.json` is already in the repo root (maintainer: `kgmodi`).
2. On your server's page at <https://glama.ai/mcp/servers>, sign in with GitHub → **Claim ownership**.
3. Glama scores you on **tool-definition quality** (60% mean + 40% *minimum*, so every tool's description matters — ours are written for this). Keep tool descriptions thorough.

## Step 5 — Smithery (optional) — ⚠️ HIPAA caveat

Smithery **dropped stdio-hosting** and offers **no BAA**. Do **not** route PHI through a Smithery-*hosted* server. Two safe options only:
- List an **MCPB local bundle** (traffic goes user → api.soapnoteapi.com directly), or
- Register a **self-hosted HTTPS URL** (your own remote server) — see fast-follows.

Lowest priority; skip until you have the remote server.

---

## Maintenance — automate releases (optional)

Add `.github/workflows/publish-mcp.yml` to the public repo:

```yaml
name: publish-mcp
on:
  push:
    tags: ["v*"]
permissions:
  contents: read
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, registry-url: "https://registry.npmjs.org" }
      - run: npm ci && npm run build
      - run: npm publish --access public
        env: { NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }} }
      - run: |
          curl -L "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_linux_amd64.tar.gz" | tar xz mcp-publisher
          ./mcp-publisher login dns --domain soapnoteapi.com --private-key "${{ secrets.MCP_PRIVATE_KEY }}"
          ./mcp-publisher publish
```
Bump `version` in `package.json` **and** `server.json`, then `git tag v0.1.1 && git push --tags`.

## Fast-follows that boost agent discovery (separate workstream, not in this package)

1. **`llms.txt`** at `https://soapnoteapi.com/llms.txt` pointing to docs, auth, the OpenAPI spec, and the `npx -y soapnoteapi-mcp` command — the 2026 default for agent-discoverable APIs.
2. **OpenAPI 3.1** at `https://api.soapnoteapi.com/openapi.json` with rich, **PHI-free** examples (agents generate calling code from examples).
3. **MCPB bundle** (`mcpb pack`) attached to a GitHub Release → true one-click install in Claude Desktop.
4. **Remote streamable-HTTP server** at `mcp.soapnoteapi.com/mcp` with **OAuth 2.1** (RFC 9728) — the enterprise/clinical default (per-user tokens, revocation, server-side PHI handling under your BAA) instead of a shared env-var key.
