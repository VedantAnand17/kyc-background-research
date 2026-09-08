# ADR-0001: The LLM chooses what to buy; code enforces money and identity

Status: accepted, 2026-09-08.

## Context

The brief scores both "agent and tool-calling design" and "budget and cost optimization" and "identity-matching accuracy and false-positive handling".
A fixed pipeline of vendor calls satisfies the budget but shows no agent design.
A free-form agent that also tracks spend and decides identity in its own reasoning is unbounded in cost, cannot be unit-tested, and produces confidence numbers nobody can defend.

## Decision

The LLM owns exactly one question at each step: which allowed capability is worth buying next given the evidence so far.
Deterministic code owns three questions: can we afford it (Spend Guard), which vendor serves it (tool layer), and who the subject is (Matcher).
The LLM also writes narrative text in the report and classifies whether an adverse-media hit is about the primary candidate.
It never writes an amount, never assigns a confidence score, and never receives raw vendor payloads.

## Consequences

- Budget correctness and identity scoring are unit tests, not prompts.
- The agent loop remains real tool calling, so the design can be demonstrated in the interview.
- Extraction code per capability is required to produce compact tool results for the model.

## Alternatives rejected

- Fixed pipeline: fails the tool-calling criterion.
- Agent-owned budget and identity: unverifiable; a hallucinated confidence is the exact false-positive failure the brief warns about.
