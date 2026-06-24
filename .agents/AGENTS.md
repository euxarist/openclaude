# Workspace Customization Rules

- Do not pass inline string arguments containing backticks (such as markdown code backticks) or other shell-sensitive characters directly to PowerShell (`pwsh`) CLI commands, as they are interpreted as escape sequences (e.g., `` `e ``, `` `a ``, `` `f ``) and will garble the text. Instead, write the text to a temporary file first and pass it using a file argument (e.g., using `--body-file` or `gh api -F body=@file`).
