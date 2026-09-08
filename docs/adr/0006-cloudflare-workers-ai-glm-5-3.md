# ADR-0006: Cloudflare Workers AI with `@cf/zai-org/glm-5.3` is the default LLM

Status: accepted, 2026-09-08.

## Context

The owner holds Cloudflare and AWS credentials and left the model choice to engineering.
The AWS IAM user available on the build machine (`bags-mcp-local`) has no Bedrock permissions, so Bedrock would need an IAM change before it could be evaluated.
Cloudflare Workers AI is reachable now, exposes an OpenAI-compatible endpoint at `https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1`, and lists 18 text models with function calling.

The agent loop needs three things: correct tool calls, parallel tool calls in the enrich phase, and a clean stop when a tool reports `budget_exhausted`.
The narrative pass needs valid structured JSON that does not invent facts, because the output is a compliance-adjacent report.
The deadline is 45 seconds for the whole request, so a step should take well under 10 seconds.

## Evidence (live smoke tests on 2026-09-08)

| Model | Tool call | Parallel fan-out | Structured JSON | Faithfulness | Step latency |
|---|---|---|---|---|---|
| `@cf/zai-org/glm-5.3` | correct | 3 calls in one turn | valid | stayed on given facts, stated that no more was known | 3.3 to 5.8 s |
| `@cf/openai/gpt-oss-120b` | correct | not tested | valid only with `max_tokens` and low reasoning effort set; empty output otherwise | invented "seasoned leader with a proven track record" from two facts despite instruction | 2.3 to 13 s |
| `@cf/deepseek-ai/deepseek-v4-pro-0813` | correct, 2 parallel calls | yes | valid | not assessed | 3.7 s for tools; 41 to 60+ s for structured output |
| `@cf/moonshotai/kimi-k2.6` | correct | not tested | not tested | not assessed | 17.7 s |

glm-5.3 also stopped calling tools and said it was finishing when handed a `budget_exhausted` result.

## Decision

- Default provider: Cloudflare Workers AI via the AI SDK `@ai-sdk/openai-compatible` provider, `LLM_PROVIDER=cloudflare`, base URL derived from `CLOUDFLARE_ACCOUNT_ID`.
- Default model: `@cf/zai-org/glm-5.3` for both the agent loop and the narrative pass.
- Documented fallback: `@cf/openai/gpt-oss-120b`, only with `max_tokens` at least 1500, `reasoning_effort: low`, and the stricter no-invention prompt; use it when speed matters more than prose faithfulness.
- Every LLM call sets `max_tokens` explicitly (1500 for the agent loop, 1200 for narrative) so reasoning models never return an empty completion.
- `openai` and `openai-compatible` remain selectable so an interviewer can run with their own key.

## Consequences

- One credential (a Cloudflare API token with Workers AI read) and one account id run the demo.
- The narrative prompt still forbids inventing facts, and the report assembler still owns every number; the model choice reduces risk, it does not remove the rule.
- If Bedrock access is granted later, adding it is a provider entry, not a redesign.

## Alternatives rejected

- AWS Bedrock: not reachable with the current IAM user.
- DeepSeek V4 Pro: structured output far too slow for the deadline.
- gpt-oss-120b as default: fastest and cheapest, but embellished facts in the narrative test.
- Kimi K2.6: 17 second steps.
