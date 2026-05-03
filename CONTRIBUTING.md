# Contributing to CCG

Thanks for your interest in contributing to CCG! This guide will help you get started.

## Development Setup

### Prerequisites

- Node.js 20+
- pnpm (`npm install -g pnpm`)
- Go 1.21+ (only for `codeagent-wrapper` changes)

### Getting Started

```bash
# Clone the repository
git clone https://github.com/fengshao1227/ccg-workflow.git
cd ccg-workflow/skills-v2

# Install dependencies
pnpm install

# Build
pnpm build

# Run tests
pnpm test
```

### Project Structure

```
skills-v2/
├── src/                    # TypeScript source
│   ├── cli.ts              # CLI entry point
│   ├── commands/           # CLI commands (init, update, menu, etc.)
│   └── utils/              # Shared utilities
├── templates/              # Installed to ~/.claude/
│   ├── commands/           # 26 slash command templates (.md)
│   ├── prompts/            # Expert prompts (codex/ + gemini/)
│   └── skills/             # Quality gates + orchestration
├── codeagent-wrapper/      # Go binary source
├── tests/                  # Vitest test files
└── bin/                    # Build output + pre-compiled binaries
```

### Key Files

| File | Purpose |
|------|---------|
| `src/utils/installer.ts` | Core installation logic |
| `src/utils/config.ts` | Configuration management |
| `src/utils/mcp.ts` | MCP tool integration |
| `templates/commands/*.md` | Slash command templates |
| `templates/prompts/` | Expert prompts for Codex/Gemini |

## How to Contribute

### Find an Issue

- Check [`good first issue`](https://github.com/fengshao1227/ccg-workflow/labels/good%20first%20issue) for beginner-friendly tasks
- Check [`help wanted`](https://github.com/fengshao1227/ccg-workflow/labels/help%20wanted) for tasks needing assistance
- Or open a new issue to propose your idea

### Development Workflow

1. Fork the repository
2. Create a feature branch: `git checkout -b feat/your-feature`
3. Make your changes
4. Run tests: `pnpm test`
5. Build: `pnpm build`
6. Commit with conventional format: `git commit -m "feat: add something"`
7. Push and create a Pull Request

### Commit Convention

We use [Conventional Commits](https://www.conventionalcommits.org/):

| Prefix | Usage |
|--------|-------|
| `feat:` | New feature |
| `fix:` | Bug fix |
| `docs:` | Documentation changes |
| `test:` | Adding or updating tests |
| `refactor:` | Code refactoring (no behavior change) |
| `chore:` | Build, CI, dependency updates |

### Code Standards

- **TypeScript**: Follow existing patterns in `src/`
- **Templates**: Markdown files in `templates/commands/` — use `{{VARIABLE}}` for template variables
- **Tests**: Use Vitest, place tests in `tests/` mirroring `src/` structure
- **Metrics**: Function complexity < 10, single function < 50 lines, single file < 500 lines

### What Makes a Good PR

- **Focused**: One concern per PR
- **Tested**: Include tests for new functionality
- **Documented**: Update README if adding user-facing features
- **Small**: Prefer multiple small PRs over one large one

## Good First Issues

Good first issues are designed to be completable in ~2 hours. They typically involve:

- **Documentation**: Fix typos, improve examples, add missing descriptions
- **i18n**: Add missing translations in command templates
- **Tests**: Write tests for untested utility functions
- **Templates**: Improve slash command templates with better examples
- **Small fixes**: Single-file bug fixes in `src/utils/`

Each good first issue includes:
- Clear problem description
- Specific files to modify
- Acceptance criteria
- Verification commands

## Review Process

| Event | Timeline |
|-------|----------|
| Issue claimed | Assigned within 1 day |
| PR submitted | First review within 3 days |
| After review feedback | Contributor has 5 days to respond |
| No response | Issue unassigned (you can reclaim later) |

## Questions?

- Open a [Discussion](https://github.com/fengshao1227/ccg-workflow/discussions)
- Check existing [Issues](https://github.com/fengshao1227/ccg-workflow/issues)

---

Thank you for contributing!
