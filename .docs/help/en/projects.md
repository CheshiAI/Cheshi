# Getting started with projects

A project is a folder containing the files you work on together. Workspaces lets you create a project or open an existing folder or repository.

## When to use it

Use this when starting a task or switching projects. Choose Create project for an empty project, Open folder for a folder already on your computer, or Clone repository to copy a remote repository.

## Steps

1. Open Workspaces.
2. To create a project, click **Create project** at the bottom. Use **Browse** to choose a parent folder and enter a **Project name**.
3. Check the destination path, then click **Create and open**. Choose another name if a file or folder already exists at that location.
4. For an existing project, click **Open folder** and select the project folder itself.
5. To copy a remote repository, open **Clone repository** and select a repository or enter its **Repository URL**. Check the **Parent folder** and **Folder name**, then click **Clone and open**.

## What happens next

The project is added to Workspaces and opens in a new window. Preparing code analysis can take time when you open a project for the first time.

Create project initializes a Git repository in the new folder. It does not create an initial commit or a remote repository. Open folder uses the existing folder you selected, while Clone repository copies a remote repository to your computer.

If creation or cloning finishes but the window fails to open, use **Open in new window** to try again. You do not need to create the completed folder again.

## Working with multiple projects in one window

Use **Add project to workspace** in the EXPLORER header to connect an existing project folder. For example, expand `cheshi` and `cheshi-flash` as separate roots and work on both in the same SESSION conversation. The connected project list persists when you reopen the window.

File search includes connected projects. Select the repository in the Git view, or choose a project from the terminal's new session menu. Split terminals keep the original session's project directory. Each repository keeps its own Git history and release configuration.

Wait for active conversation tasks to finish before changing the project list. The next conversation turn receives the updated list while retaining the selected permission mode. CodeGraph uses each project's existing index; adding a project does not create an index.

Choose **Remove from workspace** in a project row's menu to disconnect it. This does not delete folders or files, and preserves open editor buffers and terminals. Reconnect a project before saving its files again. The initial project cannot be disconnected, and overlapping folders cannot be connected together. A workspace supports up to 16 projects including the initial project.
