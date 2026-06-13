# Multi-Agent Development Workflow

This directory contains 14 specialized agents that collaborate to move features from concept to shipped product. Each agent is responsible for a specific role in the workflow and maintains focus on that role only.

## Quick Start

### First Time: Initialize Knowledge Base

When you first set up this project, run:

```
@context-scanner
```

This will:
1. Scan the repository to discover the stack, conventions, and structure
2. Create `.claude/context.md` — the authoritative reference
3. Populate the seven knowledge topic files with extracted information

After context-scanner completes, verify that `.claude/knowledge/design-language.md` reflects your project's actual aesthetic. If it's thin or missing (which is common), manually populate it with:
- Color palette (primary, secondary, accent, grays)
- Type scale (font sizes, weights)
- Spacing scale (margins, padding, gaps)
- Motion preferences
- Component patterns

Once the knowledge base is set up, other agents can work efficiently without re-scanning.

## Architecture

### Two-Tier System

**Maintenance Agents** (run outside the feature workflow):
- `context-scanner`: initial setup and major refactors only
- `knowledge-curator`: keep topic files accurate when they drift

**Feature Workflow Agents** (run in sequence as a feature moves through development):
1. project-manager
2. stakeholder
3. database-architect (CONDITIONAL)
4. backend-engineer and/or frontend-engineer
5. ui-ux-critic (CONDITIONAL, for UI changes only)
6. security-auditor (CONDITIONAL, for auth/input/PII/payments/external APIs)
7. test-engineer
8. code-reviewer
9. qa-engineer
10. devops-engineer (CONDITIONAL, for deployment changes)
11. technical-writer (CONDITIONAL, for doc-worthy changes)

### Knowledge Architecture

Seven topic files in `.claude/knowledge/` serve as the read-optimized cache:
- `stack.md` — languages, frameworks, versions, package manager, runtime
- `conventions.md` — naming, file organization, commit style, linter/formatter rules
- `schema-overview.md` — database tables, relationships, patterns
- `api-patterns.md` — endpoint structure, auth handling, error format, pagination
- `design-language.md` — colors, type scale, spacing, motion, aesthetic tone
- `infra.md` — hosting, CI/CD, env vars, secrets, deployment flow
- `decisions.md` — append-only log of architectural choices

`.claude/context.md` is the deep reference that context-scanner populates. Agents read the narrow topic files, not the full context, to keep context windows focused.

## Full Workflow per Feature

### Step 1: Break Down (project-manager)

```
@project-manager

I need to add user authentication with email/password and OAuth.
```

The project-manager produces:
- User stories with clear scope
- Testable acceptance criteria
- Dependencies and sequencing
- Out-of-scope callouts

### Step 2: Approve Scope (stakeholder)

```
@stakeholder

Review the stories from project-manager for user value.
```

The stakeholder either:
- **Approves:** feature moves to engineering
- **Revises:** asks for scope changes or clarifications
- **Rejects:** explains why (opportunity cost, doesn't serve users, etc.)

### Step 3A: Schema Design (database-architect, CONDITIONAL)

If the feature touches the database:

```
@database-architect

Design the schema for user authentication: users table, sessions, tokens, etc.
```

The database-architect produces:
- Table definitions with columns, types, constraints
- Indexes with rationale
- Forward and rollback migration strategy
- Query patterns for engineers to follow

### Step 3B: Implementation (backend-engineer and/or frontend-engineer)

```
@backend-engineer

Implement the authentication endpoints from the user stories.
```

```
@frontend-engineer

Build the login/signup UI and wire it to the backend.
```

These can run in parallel. Each produces:
- Implementation code
- Configuration changes
- Basic verification that acceptance criteria work

### Step 4: Design Review (ui-ux-critic, CONDITIONAL)

If the feature includes UI:

```
@ui-ux-critic

Review the login/signup screens for design consistency and missing states.
```

The ui-ux-critic identifies:
- Missing states (empty, loading, error, disabled, focus)
- Design inconsistencies
- Accessibility issues
- Aesthetic mismatches

Frontend-engineer then fixes findings.

### Step 5: Security Audit (security-auditor, CONDITIONAL)

If the feature involves auth, input, PII, payments, or external APIs:

```
@security-auditor

Audit the authentication flow for security vulnerabilities.
```

The security-auditor identifies:
- Exploitable vulnerabilities
- Auth flow weaknesses
- Input validation gaps
- Secret management issues

Engineers fix findings, then move to code review.

### Step 6: Testing (test-engineer)

```
@test-engineer

Write automated tests for the authentication feature.
```

The test-engineer produces:
- Unit tests for business logic
- Integration tests for API endpoints
- E2E tests for critical workflows
- Deterministic, non-flaky tests

### Step 7: Code Review (code-reviewer)

```
@code-reviewer

Review the authentication implementation and tests.
```

The code-reviewer identifies:
- Correctness bugs
- Type safety violations
- Error handling gaps
- Code style issues
- Test quality concerns

Engineers fix critical findings, then move to QA.

### Step 8: QA and Testing (qa-engineer)

```
@qa-engineer

Test the authentication feature and produce a walkthrough plan.
```

The qa-engineer produces:
- Walkthrough plan (happy path, edge cases, error paths)
- Edge-case catalog
- Bug reports if any found

### Step 9: Deployment (devops-engineer, CONDITIONAL)

If the feature needs deployment changes:

```
@devops-engineer

Prepare deployment and environment setup for authentication.
```

The devops-engineer produces:
- Environment variable documentation
- Secret setup procedure
- Deployment steps
- Rollback procedure
- Cost implications (if any)

### Step 10: Documentation (technical-writer, CONDITIONAL)

If the feature needs documentation:

```
@technical-writer

Write API documentation and deployment runbook for authentication.
```

The technical-writer produces:
- User documentation (how to sign up, log in, reset password)
- API documentation (endpoints, auth flows)
- Deployment runbook
- ADR if this is a major architectural choice

### Feature Complete

Once technical-writer (or qa-engineer if no docs needed) approves, the feature is ready to ship.

## Conditional Agents

These agents are **skipped** when not applicable to the feature:

- **database-architect** — only if the feature touches data
- **ui-ux-critic** — only if the feature includes UI surfaces
- **security-auditor** — only if the feature involves auth, input, PII, payments, or external integrations
- **devops-engineer** — only if the feature requires deployment changes, new services, env vars, or CI changes
- **technical-writer** — only if the feature is user-facing or represents a major architectural choice

A typical feature invokes 6-8 of the 11 feature-workflow agents, depending on scope.

## Invocation

### Manual Invocation

Invoke agents by name with context:

```
@project-manager

Please break down the dashboard feature into stories.
```

```
@backend-engineer

Implement the GET /users/:id endpoint from the stories.
```

### Automatic Routing

The orchestrator (Claude) routes based on agent descriptions. If you describe a feature that needs schema design, the orchestrator can suggest `@database-architect`.

## State and Knowledge Flow

Each agent ends responses with a **STATE** block containing:
- `current_task`: what this agent is currently working on
- `decisions`: key choices made
- `artifacts`: what was produced
- `open_questions`: what remains unclear
- `handoff_notes`: what the next agent should know
- `knowledge_gaps_detected`: outdated or missing topic files

If `knowledge_gaps_detected` is not empty, the orchestrator can invoke `@knowledge-curator` to refresh those files.

Example:

```
**STATE**

**current_task:** Implementing user authentication endpoints

**handoff_notes:** Backend endpoints are ready. Frontend team can now wire up the login form to POST /auth/login and handle responses.

**knowledge_gaps_detected:**
- api-patterns.md: missing error response format for auth failures
```

## Maintenance Agents

### context-scanner

Run when:
- Initial project setup
- Major framework upgrade
- New conventions adopted
- Major refactor changes structure significantly

```
@context-scanner
```

### knowledge-curator

Run when:
- A topic file drifts from current code
- Another agent flags `knowledge_gaps_detected`
- You want to capture a major architectural change

```
@knowledge-curator

Update api-patterns.md to reflect the new rate-limiting approach.
```

## Extending the System

To add a new agent:

1. Create a file in `.claude/agents/` following the GOAL / STATE / ENVIRONMENT format
2. Assign it specific topic files to read from `.claude/knowledge/`
3. Define its tools (restrict to what it actually needs)
4. Specify explicit handoffs to other agents
5. Define refusal cases (what it should reject and redirect)
6. Update this README with the new agent's role

New agents should follow the same STATE structure and constraints as existing agents.

## Common Patterns

### Parallel Work

Backend-engineer and frontend-engineer often work in parallel once the API contract is agreed:

```
@backend-engineer
Implement POST /users for user creation.

@frontend-engineer (in parallel)
Build the signup form and wire it to the backend.
```

### Conditional Routing

Example: if a feature involves user input, it goes through security-auditor before code-reviewer:

```
Implementation → security-auditor → (fixes) → code-reviewer → qa-engineer
```

Example: if a feature has no UI, skip ui-ux-critic:

```
Implementation → test-engineer → code-reviewer → qa-engineer
```

### Handoff Discipline

Each agent hands off to the next with `handoff_notes` in STATE. This prevents re-work and keeps context flowing.

## Troubleshooting

### Knowledge Files Are Out of Date

Invoke knowledge-curator:

```
@knowledge-curator

Update api-patterns.md — we changed the error response format last sprint.
```

Or if multiple files are stale:

```
@knowledge-curator

refresh all topic files
```

### Feature Scope Keeps Expanding

Project-manager and stakeholder explicitly mark out-of-scope items. If scope creep happens mid-feature, route back to stakeholder:

```
@stakeholder

The auth feature now needs to support multi-factor authentication. Does this stay in scope?
```

### Missing Context for an Agent

If an agent says `knowledge_gaps_detected: [file]`, invoke knowledge-curator:

```
@knowledge-curator

Update schema-overview.md — the auth feature revealed we're missing the sessions table definition.
```

## Best Practices

1. **Use narrow stories, not epics.** Project-manager should break features into stories that take 1-3 days to implement.

2. **Respect agent focus.** Don't ask code-reviewer to design schema or make scope decisions. Agents refuse out-of-scope work and redirect.

3. **Verify knowledge files are fresh.** Before starting a major feature, check that topic files match current code. Use knowledge-curator to refresh if needed.

4. **Document decisions.** When you make a major architectural choice, add it to `decisions.md` with context, alternatives, and why this won.

5. **Handoff discipline.** Each agent prepares the next agent with `handoff_notes`. Don't skip steps in the workflow.

6. **Conditional agents are flexible.** A small bugfix might skip database-architect, security-auditor, ui-ux-critic, devops-engineer, and technical-writer. That's fine—invoke only what you need.

7. **Test scope matches implementation scope.** Test-engineer should test what was actually built, not what might have been built.

## Summary

This workflow scales from a solo founder to a team. Each agent has a focused responsibility and clear handoffs. Knowledge files keep context current without re-scanning the entire codebase. The system is opinionated about correctness (two-phase migrations, security review before merge, tests before code review) but flexible about scope.

Read agent descriptions for details on what each one does, tools available, and when to invoke them.
