# claude-bridge

An MCP bridge that connects Claude.ai project chats to local VS Code workspaces, letting a project-level Claude delegate code work to Claude Code running on the user's machine. The bridge daemon hosts a single MCP endpoint over a Cloudflare tunnel and owns the bearer token, audit log, and (later) job queue; VS Code extensions attach to it as workspace providers.

This repository is in **P0 (bus validation)**. The only tool exposed at this gate is `ping` — enough to prove the end-to-end roundtrip from Claude.ai → tunnel → daemon → response works with auth.

## Documentation

- [Architecture overview](docs/design/00-overview.md) — topology, frozen decisions, gate sequence
- [P0 design](docs/design/01-p0-bus.md) — what ships at the first gate
- [P0 build plan](docs/design/p0-build-plan.md) — concrete file paths and build order
- [Conventions](docs/conventions.md) — TypeScript / ESM / cross-cutting concerns
- [Project state](docs/project-state.md), [milestones](docs/milestones.md), [open questions](docs/open-questions.md)

## Status

Workspace scaffolded (T-0001). Package skeletons and source code follow in subsequent tasks per the P0 build plan.
