# Bundled agents (shared scope)

Built-in specialized agents (the sheep of the herd) shipped with pi-shepherd, in the **cross-tool /
Claude-format location** (`.agents/agents`). You can reuse the same agent files
across VS Code (`.github/agents` / `.claude/agents`) and pi.

Uses the **standard VS Code custom-agent syntax** (YAML frontmatter + Markdown
body). These are the **lowest-precedence base set** — user/project agents
override a built-in with the same name.

The same durable, no-fuss agents ship in `.pi/agents/` too; the two dirs
together form pi-shepherd's bundled defaults.
