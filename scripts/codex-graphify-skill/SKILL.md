---
name: graphify
description: Use when inspecting, debugging, changing, deleting, or refactoring code in Albert's repositories, or answering questions about code wiring, callers, dependencies, and impact.
---

# Albert Shared Graphify

Use the canonical shared code graph before reading or changing source code. The graph is advisory: verify important findings in source after the graph lookup.

## Resolve the graph

Use the explicit repository map in `references/repo-map.json`. For a Git worktree, run `git rev-parse --git-common-dir` and match its canonical repository entry. If the repository is not mapped or its graph is missing, say so and continue with source inspection; never create a private replacement.

The canonical graph path is:

`/Users/albertyang0888/personas/_shared/graphify/graphs/<graph-name>/graph.json`

Always invoke:

`/Users/albertyang0888/.local/bin/graphify`

Never use a PATH-only `graphify` command.

## Query before code

- Exact symbol: run `explain`.
- Unknown entry point: run `query`, then `explain` on the best candidate.
- Before an edit, deletion, or refactor: run `affected` on the exact node.

Example:

```bash
/Users/albertyang0888/.local/bin/graphify explain "createBot" --graph /Users/albertyang0888/personas/_shared/graphify/graphs/telecodex/graph.json
```

After graphify succeeds, inspect only the source needed to confirm the result. If graph output is missing, ambiguous, reversed, or stale, state that limitation and trust the source.

## Hard boundaries

Never build, update, watch, install, or write a graph.

Never use repo-local graphify-out or leave a private graph in a workspace.

Do not call Graphiti, persona_memory, FalkorDB, or any Personal Memory path. Graphiti is the Personal Memory system; it is unrelated to this read-only code graph workflow.

Do not treat a failed graphify command, a command-looking string, or a query against another repository's graph as satisfying the lookup.
