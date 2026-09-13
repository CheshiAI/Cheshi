# Maintaining app help

The English source documents shown to users are the Markdown files in this directory (`.docs/help/en/`).
Korean documents are maintained alongside them in `../ko/`, using the same file names.
Keep both language versions when updating or translating help. The app bundles and displays both languages.
English is the default. The Languages menu on the right of the bottom status bar switches help navigation,
search labels, topic summaries, and article text between English and Korean.
The choice is remembered locally. It applies to help rather than translating the entire application;
menu names mentioned in articles continue to match the app's controls.
Switching language keeps the selected article and search text. Search uses the selected language's catalog and article bodies.
Each article includes an introduction, when to use the feature, steps, and what happens next.
Use the actual menu names from the app. Do not describe unsupported behavior or features that have not been implemented.

The renderer imports these files as text through `desktop/frontend/src/features/help/helpArticles.ts`.
Vite includes them in the build, so the installed app does not depend on repository paths or an internet connection to display help.
Documentation edits appear in the next app build; they do not automatically update help in an already distributed app.

To add an article, import it in `helpArticles.ts` and register its unique ID, list title,
description, search keywords, and related article IDs for both languages in `helpCatalog.ts`.
Keep article IDs and file names consistent across languages. Help interface translations are in `helpTranslations.ts`.
Article bodies are searchable. Help currently displays text documents without images or link navigation.
These Markdown sources can also be reused for a future public documentation site.

Run validation commands from the repository root:

```sh
bun test desktop/test/help-center.test.tsx
bun run viewer:typecheck
bun run viewer:build
```
