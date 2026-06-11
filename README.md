# PRISM — Python & R Integrated Simulation Machine

A browser-based probability **sampler & simulation** tool for statistics education,
modeled on [TinkerPlots](https://www.tinkerplots.com/). Build sampling devices
(stacks, mixers, spinners), draw animated samples, collect sampling distributions, and
explore uploaded CSV data — with the equivalent R/Python code generated alongside.

## Quick start

```bash
npm install
npm run dev
```

Then open the URL Vite prints (usually http://localhost:5173).

To make a production build:

```bash
npm run build      # outputs to dist/
npm run preview    # serve the build locally
```

## Project layout

```
prism/
├── index.html          # entry HTML
├── package.json        # Vite + React deps and scripts
├── vite.config.js      # Vite config (React plugin)
├── CLAUDE.md           # context & constraints for Claude Code (read this!)
├── src/
│   ├── main.jsx        # React entry — mounts <App/>
│   └── App.jsx         # the whole app (the artifact you've been building)
```

## Importing into Claude Code & version control

```bash
# 1. (one time) install Claude Code — native installer:
curl -fsSL https://claude.ai/install.sh | bash
#    or via npm (needs Node.js 18+):  npm install -g @anthropic-ai/claude-code

# 2. from this folder, initialize git and make the first commit:
git init
git add .
git commit -m "Initial import of PRISM from artifact"

# 3. start Claude Code in the project:
claude
```

Claude Code will read `CLAUDE.md` automatically for project context. See that file for the
architecture overview and the hard-won constraints (sampling logic, SVG quirks, etc.) that
should not be regressed.
