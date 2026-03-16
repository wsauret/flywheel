# Validation Research Reference

External validation of technical claims during plan creation. Only triggered for high-risk topics.

## Research Decision Heuristic

**Before running external research, determine if it is needed.**

### High-Risk Keywords (ALWAYS require external research)

Scan plan content for these keywords — if found, external research is REQUIRED:

- **Security:** authentication, authorization, auth, OAuth, JWT, CORS, XSS, CSRF, SQL injection, encryption, hashing, passwords, secrets, API keys
- **Payments:** payment, billing, stripe, checkout, subscription, PCI
- **Crypto:** cryptography, signing, certificates, TLS, SSL
- **Migrations:** database migration, data migration, schema change, breaking change
- **Privacy:** PII, GDPR, CCPA, personal data, user data, privacy

### Decision Logic

```
IF any high-risk topic detected:
  -> RUN external research
  -> Log: "High-risk topic detected: [topic]. Running external research."

ELSE:
  -> SKIP external research
  -> Log: "No high-risk topics. Local research sufficient."
```

---

## Context7 Workflow

For each framework/library claim that needs validation:

**Step 1: Resolve Library ID**
```
context7_resolve-library-id:
  libraryName: "[library name]"
  query: "[specific capability claimed]"
```

**Step 2: Query Specific Capability**
```
context7_query-docs:
  libraryId: "[resolved ID]"
  query: "Does [library] support [claimed feature]? Show API and examples."
```

**Step 3: Verify with Code Examples**
Look for actual API calls that demonstrate the claimed capability.

### Fallback: WebFetch

If Context7 fails or lacks coverage, use web search to find official docs.

---

## What to Validate

### Framework Docs Validation

Claims like "React Query handles X automatically" or "FastAPI supports Y" MUST be verified. Invalid claims become bugs.

**Output format (integrate directly into plan):**
- Confirmed claims: note the source in plan text
- Invalid claims: flag as `CLAIM_INVALID` in Open Questions with impact description

### Version Compatibility

Check when the plan references specific library versions:
- Peer dependency conflicts
- Breaking changes in recent versions
- Deprecated APIs

**Flag:** `VERSION_ISSUE` in Open Questions if incompatibilities found.

### Best Practices (High-Risk Only)

For security, payments, and migration topics:
- Official documentation recommendations
- Common pitfalls from library maintainer sources
- OWASP guidance (for security topics)

---

## Integration Into Plan

**Do NOT create a separate "External Research" section.** Instead:

1. Validated claims → note source inline (e.g., "confirmed via TanStack docs")
2. Best practices → integrate into relevant Implementation Phase steps
3. Invalid claims / version issues → add to Open Questions table
4. Code examples from docs → include in relevant plan sections with source attribution

This keeps the plan compact and avoids the bloat of quarantined research sections.
