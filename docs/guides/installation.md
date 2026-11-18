# Installation

Shepherd is one npm package — `@luminascale/shepherd` — with two host entry
points. Install the one that matches your host; neither host needs anything
from the other. You need [Herdr](https://github.com/herdrdev/herdr) and Node.js
22 or newer in either case.

- [Pi](#pi)
- [OpenCode](#opencode)

## Pi

Install with pi's package installer:

```bash
pi install npm:@luminascale/shepherd
```

Reload pi, then verify the extension is available with `/shepherd agents`. You
should see the bundled agent definitions, including `scout`, `planner`,
`worker`, and `reviewer`.

Pi uses the `/shepherd settings` menu for configuration (see
[Settings](../README.md#settings)), and pi's steer mode for completion notices.
No OpenCode setup is required.

## OpenCode

Add the package to your OpenCode plugin list:

```jsonc
// ~/.config/opencode/opencode.json (or the project-level .opencode/opencode.json)
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@luminascale/shepherd"]
}
```

Restart OpenCode, then verify with `/shepherd agents`. The `shepherd_*` tools
and `/shepherd` command have the same names and semantics as in Pi. You do not
need to install pi to use Shepherd from OpenCode.

OpenCode differences:

- Settings are file-based: `~/.config/opencode/pi-shepherd/config.json` (user)
  and `.shepherd/config.json` (project, with `"projectScope": true`). There is
  no settings menu yet.
- Human `/shepherd …` command output is display-only — it renders in full and
  returns control without starting an assistant turn.
- Completion notices arrive as normal parent-session messages that wake the
  model.
- Fieldnotes are bound to the OpenCode session id and the session's working
  directory, on the same `.shepherd/sessions/` layout Pi uses.
- After an OpenCode server restart, sheep keep running but their opaque ids are
  lost. You get one display-only notice listing the orphaned sheep; use
  `shepherd({ action: "reap" })` to close them safely (or respawn and close the
  old panes). Fieldnotes and queued envelopes remain on disk until reaped.

---

[Back to README](../README.md)
