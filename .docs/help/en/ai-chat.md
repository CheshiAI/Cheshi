# Working with AI

Ask questions and request work on your project through chat. Attach files or images to provide context.

## When to use it

Use chat to understand code, investigate errors, or request file changes. Describe the outcome you want, such as “Explain how to run this project.”

## Steps

1. Open a project and select a conversation or start a new one.
2. Check the model and reasoning effort in the composer, then write your request.
3. Click the paperclip-shaped **Attach files** button to add files or images. In a regular chat, you can also drag files from outside the app or from its Explorer into the composer.
4. Review the attachment list. Use an attachment's remove button if you selected the wrong file.
5. Click the send button. Review the response and results, then continue with follow-up questions. If the assistant asks for confirmation or input during a task, read the request and respond.

## What happens next

Responses and task progress appear in the selected conversation. If you requested file changes, also review the actual changes in the editor or Git view.

For a conversation you do not want listed in chat history, use **Temporary chat** in the conversation list. Temporary chat supports follow-up questions and file attachments, but closing it ends the conversation. You cannot reopen it from chat history. Copy any responses you need before closing it.


## Find previous conversations

In **Settings → TypeSafe API**, read the disclosure and enable **Allow history recall**,
then reopen the workspace. It is off by default, including after upgrading with an
existing API key. Saving or checking a key does not enable it. Ask a question such
as “Why did we stop the earlier account-switching work?”

This setting applies to all workspaces, including ones opened later. When enabled,
the assistant can search other conversations within the workspace where the search
is requested. A search does not cross into another workspace.
The question, candidate text, titles and nearby messages are sent to TypeSafe's Jev.
If Jev is unavailable or no key is configured, the same search material goes to
OpenAI's Luna low through your Codex login. Matching original messages return to
the assistant. A page with lexical matches is not padded with zero-overlap passages;
additional pages can still search semantic matches, so this is not an exact-match-only filter.

Turning the switch off cancels pending recall in all workspaces and blocks search and source-read
calls immediately, including from existing connections. It cannot retract text
already sent. You can continue to browse history locally. Jev usage and fixed-sample
connection checks use your TypeSafe allowance; Luna uses your Codex account.

## Jev in executable skills

Explicitly invoked skills can use Jev to choose yes/no branches, with Luna low
fallback when Jev is unavailable. They send the judgment input provided by the
skill, independently of the history recall switch. The runner currently requires
a source checkout and CLI invocation; see [executable skills](../../skill-flow.md).
