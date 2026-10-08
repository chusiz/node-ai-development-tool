# Roadmap

From "a workflow that runs" to "an AI tool you can trust in a real engineering pipeline."

The project already has prototype-level innovation. The next step is engineering credibility:
**permissions that are clear, state that is clear, cost that is clear, errors that recover,
results that verify, plugins that audit, flows that reuse.**

Legend: ✅ done · 🟡 in progress · ⬜ planned

## Phase 1 — Engineering trust (current, v0.6.x)

The most important thing is not more nodes — it is nodes that are trustworthy, auditable,
recoverable and composable.

| Item | Status | Notes |
|---|---|---|
| Version unification (README = package.json, git tag, changelog) | ✅ v0.6.3 | `CHANGELOG.md` + tag `v0.6.3`; release-please/Changesets automation ⬜ |
| Cross-platform e2e (no hardcoded dev drive) | ✅ v0.6.3 | `process.cwd()` based; runs on Linux/macOS |
| CLI locator cross-platform | ✅ v0.6.3 | `which`/PATH fallback instead of Windows-only `where` |
| e2e SKIP instead of crash when CLI missing | ✅ v0.6.3 | Synthetic-adapter section still covers mechanism assertions |
| Debug-log cleanup in production code | ✅ v0.6.3 | `[CHAT_HTTP]` removed |
| Golden workflow templates (enterprise coding / game-art pipeline / multi-agent competition) | ✅ v0.6.3 | 3 new built-in templates |
| Node-level error visualization + one-click Auto-Fix entry | ✅ v0.6.4 | failed node → 「送修」 creates connected repair node |
| In-app artifact preview (web / exe / game) | ✅ v0.6.4 | no more hunting in filesystem |
| Security audit before packaging (secret scan + npm audit) | ✅ v0.6.4 | report → `assets/generated/audit/audit-report.json` |
| Incremental execution (input-hash reuse) | ✅ v0.6.4 | builtin nodes only; unchanged inputs → reuse output |
| MCP Server — Claude / Cursor orchestrate workflows | ✅ v0.6.4 | `npm run mcp`, JSON-RPC over stdio |
| Python node (subprocess, cwd-locked) | ✅ v0.6.4 | reuse AI/ML ecosystem, zero token |
| Startup lazy-loading of heavy executors | ✅ v0.6.4 | canvas interactive faster |
| Governance docs (CONTRIBUTING / CoC / SECURITY / ARCHITECTURE / PLUGIN) + first-run guide | ✅ v0.6.4 | |
| Human Approval node — approve dangerous commands, review key decisions, pick among agent outputs | ⬜ | Needs async UI + execution pause/resume |
| Permission tiers — Read-only / Project-scoped write / System / Network / Env·secret | ⬜ | Show full command + affected dir + network target before each run |
| Policy / Guardrail node — deny-lists for dirs, hosts, commands | ⬜ | Enterprise-friendly |
| Secrets / Vault node — keys never in prompts, temp credential injection, env allowlist, log masking | ⬜ | |
| Rollback node — git revert, snapshot restore, auto rollback on failure | ⬜ | |
| Test Result Evaluator node — parse test reports, decide retry / route / dead-loop detection | ⬜ | |
| Workflow mid-state & resume — node state persistence, retry from breakpoint, time-travel debug, snapshot projects | ⬜ | "Where did it stop? Why? Can I rerun just this step?" |

## Phase 2 — Platform capability

| Item | Status | Notes |
|---|---|---|
| Node plugin SDK — independent npm packages, `manifest.json` (I/O schema, permission claims, version, compat, test fixtures) | ⬜ | Hot load/unload; signature (publisher + hash); worker/WASI isolation. Python-node & builtin-action extension paths are the seed (see PLUGIN.md) |
| Critic / Reviewer nodes (code / architecture / security / cost review) | 🟡 | `review` node exists; dedicated critic agent preset in templates |
| Parallel Agent node — multi-role / multi-proposal / multi-model voting | 🟡 | parallel branch + merge exists; voting & best-result selection ⬜ |
| Budget & Cost node — token/time/call caps, auto model downgrade, over-budget abort | ⬜ | |
| State Memory node — long-term project memory, preferences, decision log; vector store, export/cleanup | ⬜ | |
| Image-understanding node — image → prompt/style/composition | ⬜ | |
| Image Diff / Batch Upscale / Background Remove / Face-Consistency nodes | ⬜ | |
| Prompt Versioning node — seed/prompt/model per run | ⬜ | |
| Style Reference node (IP-Adapter / reference-only style) | ⬜ | |
| Asset Validation node — resolution, alpha channel, format, naming conventions | ⬜ | |
| Release Pipeline node — version, changelog, git tag, build, sign, artifact upload | ⬜ | |
| Publish node — GitHub Release / npm / Docker Hub / static host | ⬜ | |
| Deploy node — Docker Compose / Vercel / Netlify / SSH (K8s later) | ⬜ | |
| Health Check node — homepage 200, API up, key flows OK after deploy | ⬜ | |

## Phase 3 — Ecosystem & commercialization

| Item | Status | Notes |
|---|---|---|
| Plugin marketplace (install, rate, audit plugins in-app) | 🟡 | v0.6.2 added GitHub/Gitee URL install; curated catalog ⬜ |
| Template marketplace (share golden workflows) | ⬜ | 8 built-in templates now; export/import exists |
| Quality gate loop — generate tests → run → static analysis → type check → dep scan → build → e2e, feed results back to agent ("test fail → auto fix → re-verify") | ⬜ | The step that turns "AI generator" into "AI software factory" |
| Per-project permission profiles & audit log | ⬜ | |
| Team / enterprise edition | ⬜ | |

## Vision

Not "drag ChatGPT into a flowchart." The core value is turning an uncontrollable AI process
into an engineering system that is **reviewable, pausable, recoverable, rollback-able** —
a low-code AI DevOps platform for individual developers and small teams.

Contributions welcome — pick any ⬜ item and open a PR. See `CONTRIBUTING.md`.
