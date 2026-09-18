# Operating systems

Use the host's shell and filesystem paths. The same skill tree supports Windows, Linux, and macOS; application-specific operations still require their application. For example, iOS simulator cleanup requires macOS and Xcode.

- Run JavaScript helpers with `node <script> ...` and bundled TypeScript tools with `bun <script> ...`. Windows does not execute a script just because its first line names an interpreter.
- Run `.sh` helpers with Bash. On Windows, use Git for Windows' `bin/bash.exe`, located beside its `cmd/git.exe` directory, or run the entire workflow inside WSL. Windows' `System32/bash.exe` launches WSL and is not Git Bash. Keep a workflow's tools and paths in one environment.
- Shell helpers require Bash and its standard Unix utilities. Git Bash provides these on Windows. The worktree audit also needs Node, Git, GitHub CLI, jq, and ripgrep on that shell's PATH. It warns and withholds a safe classification when discovery tools fail.
- Use the host temporary directory, such as `os.tmpdir()` in Node or `$env:TEMP` in PowerShell. Treat `<temp-dir>` examples as placeholders. Do not assume `/tmp/` exists on Windows.
- Quote path arguments, especially paths containing spaces. PowerShell environment assignments use `$env:NAME = 'value'`; Bash uses `export NAME='value'`. PATH entries use `;` on Windows and `:` on Unix. Scripts should use the platform's path delimiter.
- For disk space, use `Get-PSDrive -PSProvider FileSystem` in PowerShell or `df -h` in Bash. Use `git worktree remove` for approved worktree removal, and the host's filesystem tools for other approved cleanup.

The repository keeps shell scripts with LF line endings. Copy their companion files too: `worktree-audit.sh` reads worktree records through `worktree-records.mjs`. A skills-only installation already includes both.
