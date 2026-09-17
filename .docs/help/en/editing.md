# Editing files

Open a file in Explorer, edit its contents, and save your changes to the file on your computer.

## When to use it

Use the editor to change documents or code yourself, or to review changes made by AI.

## Steps

1. Expand folders in **EXPLORER** and open the file you want to edit.
2. Check the file name and path in the editor tab.
3. Edit the text. Unsaved changes are marked on the tab, and **Modified** appears in the file information.
4. Click the **Save** icon, or press **⌘S** on macOS or **Ctrl+S** on Windows and Linux.
5. If an error appears, read the message. If another program changed the same file, review its current contents before trying to save again.

## Find text in files

- Press **⌘⇧F** on macOS or **Ctrl+Shift+F** on Windows and Linux to open **Find in Files**. Type the text to find, turn on **Match case** or **Regex** as needed, and press **Enter** or click a result to open the file at that line.
- Use the arrow keys to move between results and press **Esc** to close. Files ignored by Git and folders such as `node_modules` and build output are not searched.

## What happens next

When saving succeeds, your changes are written to the file. Supported text files are also recorded in Local history so you can compare previous contents.

Saving does not commit or push changes to Git. Run Commit separately to record your work in Git history. Images and other unsupported files cannot be edited as text.
