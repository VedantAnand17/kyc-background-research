# Technical Assignment: Advanced KYC and Background Research API

Source: [Google Doc](https://docs.google.com/document/d/1eeXYDlp3zdHHuPLSJKcKzqBGuLGYxLP8pdh2LrfPqXM/edit?tab=t.0)

Supporting docs: [docs.perflow.ai](https://docs.perflow.ai/) (same gated site as [docs.perflo.ai](https://docs.perflo.ai/))

## Objective

Build a backend service that performs automated KYC and in-depth background research on an individual using Perflo pay-per-use APIs.

## Requirements

### 1. API inputs

Create an endpoint that accepts:

- First name and last name
- Date of birth, if available
- Address, city, and country, if available
- Maximum research budget

### 2. Data collection

Use a combination of relevant Perflo marketplace APIs, such as:

- LinkedIn
- Twitter/X
- Instagram
- Web and deep-search providers
- Public-record and risk-data providers
- Other relevant marketplace endpoints

Collect as much relevant information as possible, including:

- Contact and professional details
- Employment history and résumé information
- Social profiles and public posts
- News and public records
- PEP and sanctions matches
- Fraud, scam, or other risk indicators

### 3. Budget-aware execution

The service must decide which APIs to call based on the supplied budget:

- A lower budget should produce a basic assessment.
- A higher budget should produce a deeper assessment.
- The total cost must remain within the specified budget.

### 4. Agent orchestration

Include an LLM or agent layer that:

- Selects and calls the appropriate tools
- Combines and analyzes results
- Avoids unnecessary or duplicate calls
- Resolves conflicting information where possible
- Produces a structured final report

### 5. API output

Return a clear background-research report containing:

- Individual’s profile and discovered information
- Sources used
- Potential matches and confidence levels
- PEP, sanctions, fraud, and reputational risks
- Overall risk assessment
- APIs called, their individual costs, and total cost
- Warnings where identity or information could not be verified

## Evaluation criteria

During the technical call, we will assess:

- Correctness and completeness
- API and system architecture
- Budget and cost optimization
- Response speed
- Agent and tool-calling design
- Identity-matching accuracy and false-positive handling
- Code quality, documentation, and error handling
