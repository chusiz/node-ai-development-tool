# Contributing to Node AI Development Tool

Welcome to the Node AI Development Tool contributor community! The project started with one person and is waiting for the right people to take it further.

## How you can help

- **Open an issue**: report bugs, suggest new node types or features;
- **Fix bugs / add features**: fork the repo and open a pull request;
- **Write docs / tutorials**: README, example workflows, integration guides;
- **Test**: run the e2e suite and report coverage gaps.

## Development environment

- Node.js 20+, npm 10+;
- Windows is the primary target (macOS / Linux are theoretically usable but not fully verified);
- Local image generation needs a Stable Diffusion base model (`.safetensors`), specified via `CHUSIZ_SD_CHECKPOINT`.

## Development workflow

```bash
npm install
npm run dev            # launch the app
npm run typecheck:node && npm run typecheck:web   # type checks
npm run e2e            # full regression (run before every commit)
```

## Code conventions

- `src/shared/` is the **single source of truth**: node types are registered in `nodeRegistry.ts`. Adding a node = one registry declaration + a renderer component + a config panel + an executor;
- Built-in action executors are registered in `src/main/builtin/registry.ts` (nodes that consume no tokens);
- UI component mappings are one-liners each in `renderer/src/flow/nodeTypes.ts` and `renderer/src/components/NodeConfig/panelRegistry.ts`;
- Before committing: both typechecks green + e2e green (cases depending on a real LLM are skipped automatically).

## PR checklist

1. No local paths, API keys, or credentials hardcoded — always use environment variables;
2. New node types come with e2e assertions;
3. README updated in sync (new capabilities go into the features table).

## Code of conduct

Be friendly, respectful, and stick to the topic. English and Chinese are both welcome.
