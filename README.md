# BIMO Agent Runtime

BIMO is a bounded, tool-driven technical operations agent:

`READ -> REASON -> SELECT TOOL -> VALIDATE -> APPROVE -> ACT -> VERIFY -> RECOVER`

Phase 4 adds real operational visibility into Vercel deployments, network health, and EVM transactions while preserving the existing Anakin research and AI reasoning integrations.

## Commands

```bash
npm install
npm test
npm run build
```

`npm run build` performs strict TypeScript checking without emitting files. Tests inject provider mocks and never require live credentials or network availability.

## Phase 5 Interface

The browser workspace is a presentation layer over the existing `AgentRuntime`. The Node application service owns runtime creation, event delivery, session snapshots, and deferred approval decisions. The browser never receives provider credentials and never calls tools directly.

Run the credential-free interface demo in two terminals:

```powershell
npm run dev:api
npm run dev
```

Open `http://localhost:5173`. The interface server uses the existing mock deployment providers through the real runtime so the timeline, evidence, approval boundary, verification, and recovery behavior are genuine runtime output. Browser speech recognition and synthesis are used when supported; the text field remains available as an accessible fallback.

For a production adapter, replace the `RuntimeFactory` supplied to `BimoApplicationService` with the existing Vercel/Anakin/network composition. No frontend changes are required.

## Environment

Export only the credentials required by the demo being run:

```text
ANAKIN_API_KEY=
OPENAI_API_KEY=
VERCEL_TOKEN=
WEB3_RPC_URL=
```

Optional AI provider configuration:

```text
OPENAI_MODEL=gpt-4o-mini
OPENAI_BASE_URL=https://api.openai.com/v1
```

A custom OpenAI-compatible endpoint must support the Responses API and JSON-schema structured outputs. `.env` files, private keys, and PEM files are ignored; the demo commands read exported environment variables and do not load `.env` automatically.

## Live Demos

### Vercel deployment

Requires `OPENAI_API_KEY`, `ANAKIN_API_KEY`, and `VERCEL_TOKEN`. The deployment argument can be a Vercel deployment ID, hostname, or full URL. Consequential Vercel actions use an interactive CLI approval prompt.

```powershell
$env:OPENAI_API_KEY = '...'
$env:ANAKIN_API_KEY = '...'
$env:VERCEL_TOKEN = '...'
npm run demo:vercel -- dpl_yourDeploymentId
```

### Failed Web3 transaction

Requires `OPENAI_API_KEY`, `ANAKIN_API_KEY`, and an EVM-compatible `WEB3_RPC_URL`.

```powershell
$env:OPENAI_API_KEY = '...'
$env:ANAKIN_API_KEY = '...'
$env:WEB3_RPC_URL = 'https://your-rpc-endpoint'
npm run demo:web3 -- 0xYourTransactionHash
```

This demo is read-only. It does not sign, broadcast, replace, or cancel transactions.

### Network diagnostics

Requires `OPENAI_API_KEY`.

```powershell
$env:OPENAI_API_KEY = '...'
npm run demo:network -- https://api.example.com/health
```

The model can select HTTP, DNS, and TLS tools based on the available evidence. HTTP response bodies are not added to investigation state.

## Real Operations

- `vercel_get_deployment`: normalized deployment, project, Git, status, and timestamps.
- `vercel_get_deployment_logs`: bounded error-first build log evidence.
- `vercel_check_deployment`: deployment state plus optional HTTP health verification.
- `vercel_redeploy`: real Vercel redeployment behind consequential approval.
- `vercel_rollback`: SDK-supported rollback request behind consequential approval; acceptance is reported separately from verified completion. The Vercel operations runtime independently looks up the target deployment, checks HTTP health, and confirms alias assignment when verifying rollback routing.
- `http_health_check`: status, latency, redirects, and selected response headers.
- `dns_lookup`: A, AAAA, CNAME, MX, TXT, NS, CAA, and SRV records.
- `tls_check`: verified handshake, certificate, protocol, cipher, and expiry details.
- `web3_transaction_diagnostics`: chain, transaction, receipt, block, gas, status, and available revert evidence.

Provider errors are converted into structured tool failures so the AI can reason over authentication errors, rate limits, timeouts, unavailable providers, malformed responses, and RPC errors. Credentials and credential-like tool values are redacted before entering investigation history or subsequent model context.

The architecture remains:

```text
AI proposes
BIMO validates registered tool and arguments
BIMO derives risk and applies policy
BIMO requests approval when consequential
BIMO executes through the provider abstraction
BIMO records normalized evidence
BIMO verifies and recovers within hard limits
```

There is no shell execution, wallet signing, private-key handling, frontend, voice layer, database, or second agent runtime.
