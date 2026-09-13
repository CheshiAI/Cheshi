# Recording and sharing with Git

Commit records selected changes in Git history. Push sends commits to a connected remote repository.

## When to use it

Use Git to record completed work in meaningful steps or share it with others. Your project must have a Git repository. Pushing also requires a remote repository and permission to access it.

## Steps

1. Save your file changes in the editor, then open **Github** from the sidebar.
2. Select files in **Local changes** to review additions and deletions.
3. Use the checkboxes in **UNSTAGED** to move the files you want to commit into **STAGED**. Staged changes are the changes included in your next commit.
4. Describe what changed in **Commit message**, then click **Commit**.
5. To share commits remotely, check the current branch in **Pull requests**. When a **Push** button followed by the branch name is shown, click it to send that branch's commits.

## What happens next

Committing records the selected changes in local Git history. A successful push also updates the remote repository. Saving, committing, and pushing are separate actions.

The Push button in Pull requests appears depending on the branch and remote state. Its absence does not mean every change has been shared. Newly created projects do not have a remote connected automatically; prepare and connect a remote before pushing.

Local history records file contents automatically for recovery. A Git commit explicitly records selected work. Saving a file or restoring a local snapshot alone does not create a Git commit.
