# Troubleshooting

Start with the error message on the affected screen to find the next step.

## When to use it

Refer to this guide when signing in, opening a project, receiving an AI response, restoring a file, or completing a Git operation fails.

## Steps

1. **Sign-in or startup is blocked:** Complete the CLI installation and sign-in steps shown in the app. After authenticating in your browser, return to the app and check the connection status.
2. **A project will not open:** Confirm that the folder exists and you can access it. If creation or cloning has finished, try **Open in new window**, or select that folder through **Open folder** in Workspaces.
3. **An AI response fails:** Check the error message, account connection, and internet connection. If the app says your draft and attachments were restored after a send failure, review the composer and send again. If Temporary chat cannot load models, copy anything you need before closing and reopening it.
4. **An attachment fails:** Check that the file has not moved or been deleted, then select it again with **Attach files**. Wait for any attachment processing to finish.
5. **A local snapshot cannot be restored:** Save unsaved editor changes first. Use **Refresh local history** to update the list and current file, then compare again. A snapshot matching the current file does not need to be restored.
6. **A commit fails:** Check that your saved changes are in **STAGED** and that you entered a **Commit message**. For author identity errors, check your Git name and email settings.
7. **A push fails:** Check the remote connection, Git authentication, and your write permission for the repository. Signing in to an AI account is separate from access to a remote Git repository. If remote changes caused the rejection, review those changes first.

## What happens next

After addressing the cause, retry the failed operation. If it fails again, record the error message, the action you took, the app version, and your operating system to help reproduce and explain the problem.

Before sharing error details, check for passwords, tokens, and private file contents. You do not need to delete your working files or project folder to retry an operation.
