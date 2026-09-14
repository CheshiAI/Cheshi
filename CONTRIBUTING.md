# Contributing to Cheshi

Bug reports, feature ideas, documentation improvements, and focused pull requests
are welcome. You can write issues and PR descriptions in English or Korean.
이슈와 PR 설명은 한국어로 작성하셔도 됩니다.

## Report a bug or suggest a feature

Search [existing issues](https://github.com/CheshiAI/Cheshi/issues) first. If the
same problem is already reported, add your reproduction details there. Otherwise,
use [the issue forms](https://github.com/CheshiAI/Cheshi/issues/new/choose).

For bugs, include the app version and build from About Cheshi, operating system,
chip, installation method, reproduction steps, and expected versus actual behavior.
Share relevant errors and screenshots with credentials, personal information, and
private project content removed. Do not upload your entire user-data directory.

For features, describe the workflow or problem, the proposed behavior, and any
alternatives you considered. Discuss large changes in an issue before implementing
them so scope and direction can be agreed on.

## Submit a pull request

1. Fork the repository and create a focused branch from `main` in your fork.
2. Follow the [source setup](README.md#run-from-source).
3. Read [AGENTS.md](AGENTS.md) and, for desktop changes,
   [desktop/AGENTS.md](desktop/AGENTS.md).
4. Make the change and run the relevant checks below.
5. Open a PR against `CheshiAI/Cheshi:main`. Explain the problem, resulting
   behavior, and validation results. Link the related issue when available.

Keep unrelated refactors out of the PR. Add regression tests for meaningful
behavior changes and include screenshots for visible UI changes. If using an AI
coding assistant, review its changes and verify the behavior before submitting.
Do not include local credentials, indexes, build artifacts, or machine-specific
settings. Contributors do not need signing certificates to build or test changes.

Commit messages follow `[flag] summary`, using lowercase English letters and
spaces, for example `[fix] correct workspace loading feedback`.

## Validate the affected area

Run commands from the repository root with Bun:

| Area | Typecheck |
| --- | --- |
| Renderer and React | `bun run viewer:typecheck` |
| Electron, desktop services, configuration, scripts | `bun run desktop:typecheck` |
| Desktop service tests | `bun run codegraph:server:typecheck` |
| Public CLI | `bun run cli:typecheck` |
| CodeGraph engine | `bun run codegraph:typecheck` |

Run the directly affected test suites. Use `bun test <test-file>` for Bun suites;
retain `node --test <test-file>` for suites listed in the `desktop:test` script.
For renderer changes, also run `bun run viewer:build`. Directly loaded Electron
modules must remain compatible with native Node TypeScript stripping; follow the
runtime verification guidance in AGENTS.md.

For documentation-only changes, check links, referenced commands, and
`git diff --check`. Full application builds are unnecessary. State clearly in the
PR which checks ran and any checks you could not complete.

## License

Contributions to Cheshi's original code are made under its [MIT License](LICENSE).
Preserve third-party notices and license terms when changing bundled components.
