# Restoring previous versions

Local history lets you compare a file's previous contents stored on this computer with its current saved contents, then restore a version.

## When to use it

Use it to undo a saved change or find earlier contents you did not commit to Git. Opening or saving a supported text file records its contents. External changes detected by the app are also recorded.

## Steps

1. Right-click a file in Explorer or its editor tab and choose **Local history**. You can also use the history icon in the editor.
2. Select a time from the list on the left. **Saved** contains a saved version, **Original contents** is the first recorded version, and **External change** contains the contents captured when an external change was detected.
3. **Selected snapshot** on the left shows the recorded contents at the selected time, which may not be the immediately preceding version. **Current saved file** on the right shows the file currently on disk, excluding unsaved edits.
4. Review the differences, then click **Restore this version**. Save any unsaved editor changes first.
5. If another program changed the file after your comparison, review the updated contents before restoring.

## What happens next

The file is restored to the selected snapshot. Its current contents are recorded just before restoration so you can return to them later. Git commits and branches stay unchanged, although Git may show the restored file as modified.

History is stored in Cheshi's user data outside the project. The default limits are up to 30 days and 100 MiB per workspace, with older entries removed first. This is not a remote backup.

Intermediate changes made while the app is closed, or contents overwritten before recording began, cannot be recovered. Binary files such as images, recreation of deleted files, and whole-project restoration are not supported. If a file is renamed, its earlier history remains under the old path.
