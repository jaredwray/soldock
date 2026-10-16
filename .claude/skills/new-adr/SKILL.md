---
name: new-adr
description: Create or supersede an Architecture Decision Record in plan/adr/ using the template, link it from architecture.md and the affected stage/tasks. Use when a spike concludes, when a design choice is made or changed, or when a dependency/Cloudflare product is added.
---

# New ADR

1. Find the next number: `ls plan/adr | sort | tail -1`. Numbers are never reused. Task text never
   pre-assigns numbers. If a task says "an ADR titled 'X'", use that title, take the next free
   number, and update any task or architecture text that refers to the title so it links the file.
2. Copy `plan/adr/0000-template.md` to `plan/adr/NNNN-<kebab-title>.md`. Use an imperative title,
   for example "Use IronCalc for spreadsheet calculation".
3. Fill in Context (with evidence: benchmarks, links, spike results), Decision, Consequences and
   Alternatives considered. Set the status:
   - `proposed` if a spike still has to confirm it
   - `accepted` once decided
   - when replacing an older ADR, set the old one to `superseded by ADR-NNNN` and change nothing else in it
4. Link the ADR from `plan/architecture.md`, at the section it affects, and from the stage design notes or tasks that depend on it.
5. If the decision adds a runtime dependency, run `pnpm licenses:check`. If the dependency is
   compiled-only (no source), ADR-0011 requires this ADR to justify it.
6. If the decision changes the plan, edit the affected tasks in the same PR, then run `pnpm plan check`.
7. For significant decisions, ask the **`plan-reviewer`** agent (Fable) to review the ADR before you open the PR.
