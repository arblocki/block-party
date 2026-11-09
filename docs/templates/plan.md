# Plan format

Every run starts from an approved plan in this format (see `docs/ARCHITECTURE.md` 3.1). The
implementer, the Codex reviewer, the verify stage, and the final human review all read the
same plan, so it has to be specific enough for each of them.

block-party validates the plan on import: the required sections must exist and **Acceptance
criteria** must contain at least one checklist item. Everything else is free-form Markdown.

Copy the template below into a new file.

---

```markdown
# <Short title of the change>

## Goal

<One or two paragraphs: what should be true when this is done, and why it matters. Written
for someone who hasn't seen the conversation that produced the plan.>

## Context

<What exists today that this builds on or changes. Link files as `path/to/file.ts:123`.
Mention relevant prior decisions, constraints, and anything surprising you found while
exploring.>

## Approach

<How to build it. Break into numbered steps when order matters. Name the files and modules
each step touches. When parts can be built in parallel, say so and give each part a clear
file/module owner, so Sonnet subagents don't collide.>

1. ...
2. ...

## Acceptance criteria

<Observable, checkable statements. Each one becomes a row in the verify stage's evidence
and in the final review. Prefer "running X shows Y" over "X is implemented". Tag criteria
that can only be checked a certain way, e.g. `[browser]`, `[mcp]`, `[db]`, `[manual]`.>

- [ ] ...
- [ ] ...

## Tests

<Which unit/integration tests to add or change, and what they must cover (edge cases,
failure paths).>

## Out of scope

<Things a reasonable implementer might be tempted to do but must not, e.g. refactors,
dependency upgrades, unrelated fixes.>

## Risks and open questions (optional)

<Anything the reviewer should look at extra carefully, and anything still undecided. An
open question that blocks implementation means the plan isn't ready to approve.>
```

---

## Validation rules (block-party, on import)

| Rule | Why |
|---|---|
| Sections `Goal`, `Approach`, `Acceptance criteria`, `Out of scope` exist (H2, case-insensitive) | Every downstream stage depends on them |
| `Acceptance criteria` has at least one `- [ ]` item | Verify and review need something checkable |
| No unresolved `TODO`/`TBD` in `Approach` or `Acceptance criteria` | An unfinished plan shouldn't be approvable |
| Plan is stored by content hash; edits create a new version | Every stage records exactly which plan it used |
