---
title: "Skill Registry"
type: "feature"
status: "active"
source_paths:
  - "src/skills.ts"
  - "tests/llm/runtime.test.ts"
  - "src/types.ts"
updated_at: "2026-04-12"
---

`src/skills.ts` provides ordered skill discovery and loading from filesystem roots.

Facts from source:
- The registry scans each configured root recursively for `SKILL.md` files.
- Public skill identity comes from frontmatter `name` and `description`, not from folder names.
- Later roots override earlier roots on duplicate `skillId`, which gives project-local skills precedence over global defaults.
- The registry is on-demand only: `sync`, `listSkills`, `getSkill`, and `loadSkill` rescan as needed instead of relying on background watchers.
- A filesystem adapter can be injected, which is how `tests/llm/runtime.test.ts` proves precedence behavior without touching disk.

Operationally, skills are instruction assets rather than executable tools. They become visible through the built-in `load_skill` tool described in [[src-builtins]].

Use this page with [[environment-vs-per-call]] when deciding whether a harness should change skill roots globally or only for a specific call.