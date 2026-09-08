# ADR-0004: TypeScript on Node 22 with Hono, Zod, the Vercel AI SDK, and SQLite

Status: accepted, 2026-09-08.

## Context

The product is a single-process HTTP service for a take-home interview.
Perflo's official quickstart and typed client are TypeScript with no dependencies beyond `fetch`.
The brief scores documentation and code quality; the demo must run with whichever LLM key the interviewer holds.

## Decision

- Node 22, TypeScript, ESM, pnpm.
- Hono with `@hono/zod-openapi` and `@hono/node-server`; OpenAPI is generated from the same Zod schemas that validate input and the report.
- Zod for every schema: request, report, tool arguments, LLM structured output, config.
- Vercel AI SDK (`ai`) for tool calling and structured output; the provider is an environment choice among Cloudflare Workers AI (default, ADR-0006), OpenAI, and any OpenAI-compatible endpoint.
- Perflo client adapted from `perflo-quickstart/src/perflo.ts`.
- SQLite via `better-sqlite3` for jobs, ledger, and sources.
- pino for structured logs, Vitest for tests, tsx for development.

## Consequences

- One schema drives validation, documentation, and typing.
- Zero infrastructure to run; the ledger is still durable.
- Swapping providers or moving to Postgres later is a module change, not a redesign.

## Alternatives rejected

- Python with FastAPI and LangChain: fine in isolation, but the Perflo client would be rewritten and LangChain adds abstraction the interview would have to see through.
- Postgres: infrastructure for a single-process demo.
- Direct Anthropic SDK: locks the demo to one provider.
