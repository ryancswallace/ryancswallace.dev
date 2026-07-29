---
author: Ryan Wallace
pubDatetime: 2026-07-28T18:53:00Z
modDatetime: 2026-07-28T18:53:00Z
title: "Python Project Foundry: A Production-Ready Repository in One Command"
slug: python-project-foundry-a-production-ready-repository-in-one-command
featured: true
draft: false
tags:
  - python-project-foundry
  - cli
  - python
  - developer-tools
  - project-scaffolding
  - automation
description: Python Project Foundry generates production-ready Python repositories with testing, documentation, security, CI, containers, and releases built in.
---

# Python Project Foundry: A Production-Ready Repository in One Command

Starting a new Python library is quick and easy, but creating the surrounding repository--testing, documentation, CI, security checks, packaging, releases, and containers--takes considerably longer.

[Python Project Foundry](https://github.com/ryancswallace/python-project-foundry) generates an opinionated, production-ready repository for a Python package or library from an interactive questionnaire.

```console
uvx python-project-foundry ./my-package
```

Answer a few questions, then start developing.

## What Foundry generates

Foundry creates more than just a Python package skeleton:

```text
Questionnaire
     │
     ▼
Python package repository
├── Typed src/ package
├── Tests and examples
├── Documentation site
├── Development environment
├── Quality and security checks
├── GitHub Actions workflows
├── Container images
└── Release automation
```

The result is a repository with a consistent interface for local development and CI.

## Quick start

The requirements to use the single-line invocation method below are `uv`, Git, Make, Node.js, and npm.

Generate a repository:

```console
uvx python-project-foundry ./orbit-tools
```

Foundry prompts for values such as:

- Project and package names
- Description and initial version
- Supported Python versions
- License
- GitHub owner and repository
- Documentation URL
- Maintainer name and email
- Coverage threshold

After generation:

```console
cd orbit-tools
make check
```

On Linux and macOS, Foundry can also initialize Git, install dependencies, create the initial commit, and install Git hooks.

Alternatively, if you don't have `uv` installed, you can use the bootstrap script method to scaffold a new project:

```console
curl -LsSf https://raw.githubusercontent.com/ryancswallace/python-project-foundry/main/ppf |
  sh -s -- ./orbit-tools
```

## Modern Python packaging defaults

Generated repositories use a modern `src/` layout:

```text
src/
└── orbit_tools/
    ├── __init__.py
    ├── _core.py
    ├── exceptions.py
    └── py.typed
```

Each project includes:

- PEP 621 package metadata
- Hatchling builds
- A `py.typed` marker
- Explicit Python version bounds
- Locked dependencies through `uv`
- Wheel and source-distribution builds
- Installation smoke tests
- Twine metadata validation

## One interface for development

The generated `Makefile` provides a discoverable command surface:

```console
make help
```

Common commands include:

| Goal                      | Command             |
| ------------------------- | ------------------- |
| Install dependencies      | `make install`      |
| Run tests                 | `make test`         |
| Check formatting and lint | `make lint`         |
| Check types               | `make typecheck`    |
| Build documentation       | `make docs`         |
| Run the standard suite    | `make check`        |
| Build distributions       | `make build`        |
| Test containers           | `make docker-check` |

This keeps local development and CI aligned. Developers don't need to memorize every underlying tool invocation.

## Testing and quality controls

Generated projects combine several complementary tools:

| Concern                 | Tools                          |
| ----------------------- | ------------------------------ |
| Tests                   | Pytest, Hypothesis, pytest-cov |
| Linting and formatting  | Ruff                           |
| Type checking           | BasedPyright                   |
| Dependency declarations | deptry                         |
| Markdown                | markdownlint                   |
| Spelling                | CSpell                         |
| Workflows               | actionlint, Zizmor             |
| Automation matrix       | Nox                            |

Test coverage enforcement is configurable during generation.

The Linux CI matrix tests every selected Python version from the minimum through the default. macOS and Windows test the default version.

## Documentation included

Every repository includes a MkDocs Material site with:

- A project overview
- Development instructions
- Explanations and how-to pages
- Release runbooks
- Generated API reference
- Strict documentation builds
- Link checking
- A GitHub Pages deployment workflow

Preview it locally:

```console
make serve-docs
```

The docs configuration uses the repository and package metadata supplied during generation.

## Security and supply-chain checks

Security tooling is present from the first commit:

- Bandit source scanning
- pip-audit dependency auditing
- detect-secrets
- GitHub dependency review
- CodeQL
- OpenSSF Scorecard
- Zizmor workflow analysis
- Trivy container scanning
- CycloneDX SBOM generation
- Artifact attestations

These checks establish strong security baseline from the initial stages of development.

## Container support

Generated repositories include a multi-stage Dockerfile with separate runtime and test targets.

```text
Base image
├── Runtime image
└── Test image
```

Available workflows can:

- Build the runtime image
- Run package tests inside an image
- Smoke-test the runtime image
- Scan both images for critical vulnerabilities
- Publish images to GitHub Container Registry
- Generate build attestations

Run the complete local container suite with:

```console
make docker-check
```

## Open-source and proprietary licensing

Foundry can generate:

| Choice                     | Identifier               |
| -------------------------- | ------------------------ |
| MIT License                | `MIT`                    |
| BSD 3-Clause License       | `BSD-3-Clause`           |
| Apache License 2.0         | `Apache-2.0`             |
| Mozilla Public License 2.0 | `MPL-2.0`                |
| GNU GPL version 3          | `GPL-3.0-only`           |
| Proprietary notice         | `LicenseRef-Proprietary` |

The selected value is used consistently in the license file, package metadata, citation metadata, README, and container labels.

The proprietary option provides a general all-rights-reserved notice.

## GitHub publishing is explicit

Generating files does not automatically create external resources.

When the repository is ready, preview publishing:

```console
uvx python-project-foundry publish \
  --visibility private \
  --dry-run
```

Then publish it:

```console
uvx python-project-foundry publish \
  --visibility private
```

The `publish` command:

- Reads the configured GitHub destination
- Validates the local Git repository
- Creates the remote repository
- Pushes `main`
- Configures GitHub Pages

Visibility must be selected explicitly:

- `private`
- `public`
- `internal`

## Template updates

Generated repositories record their original Foundry template version and questionnaire answers.

Preview an update:

```console
uvx --refresh python-project-foundry update --pretend
```

Apply it:

```console
uvx --refresh python-project-foundry update
```

Foundry uses Copier’s update support to preserve project changes where possible. If the same content changed in both the project and template, conflicts are left for review.

After updating:

```console
git diff
make check
```

Updates are pinned to the installed Foundry release rather than selecting the latest template version.

## Automation-friendly generation

Interactive prompts are typically most convenient, but generation can also be unattended:

```console
uvx python-project-foundry ./orbit-tools --defaults
```

Useful options include:

| Option         | Effect                             |
| -------------- | ---------------------------------- |
| `--defaults`   | Accept questionnaire defaults      |
| `--pretend`    | Preview without writing            |
| `--skip-tasks` | Render files without setup tasks   |
| `--overwrite`  | Replace existing destination files |

## When to use Foundry

Python Project Foundry is useful when you want a package repository with mature engineering practices from its first commit.

It provides:

- Consistent local and CI commands
- Typed Python packaging
- Cross-platform testing
- Documentation and Pages deployment
- Security and supply-chain checks
- Container workflows
- Release automation
- Explicit GitHub publishing
- Template updates

Foundry quickly creates strong repo scaffolding so you can focus on developing your Python application itself.
