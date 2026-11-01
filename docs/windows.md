# Use Quest on native Windows

Quest's local commands, setup, and removal run from PowerShell or CMD without
WSL, Administrator access, or Developer Mode. Release archives contain a
standalone `quest.exe`; Node and Bun are not required to run it.

## Supported systems

The Windows builds target x64 and ARM64, using the repository's pinned Bun.
Bun requires [Windows 10 version 1809 or later](https://bun.sh/docs/installation)
and an x64 processor with SSE4.2; ARM64 uses its native build. The release and
core/lifecycle CI use [Windows Server 2022 x64 and Windows 11 ARM64 runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

This change adds Windows artifacts to the next release containing it. Existing
releases such as v0.1.0 do not contain them. Choose an actual published tag
with the matching ZIP before installing. See the [release list](https://github.com/moq-dev/quest/releases).

## Install

If your repository already uses mise, pin a release with
`mise use github:moq-dev/quest@<tag>` and confirm `quest --version`.
[The GitHub backend](https://mise.jdx.dev/dev-tools/backends/github.html)
selects the matching release asset. Its Windows install is checked separately
from the manual archive path after publishing.

To install an archive manually, replace the tag below with a release that
contains Windows assets, then run this in PowerShell. It verifies the archive
against that release's SHA256SUMS before extracting it. Stop any running Quest
command before replacing an existing Windows executable.

```powershell
$tag = 'vX.Y.Z'
$target = switch ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture) {
    X64 { 'x86_64-pc-windows-msvc' }
    Arm64 { 'aarch64-pc-windows-msvc' }
    default { throw 'Quest has no Windows build for this architecture' }
}
$archive = "quest-$target.zip"
$base = "https://github.com/moq-dev/quest/releases/download/$tag"
$work = Join-Path ([System.IO.Path]::GetTempPath()) ('quest download ' + [guid]::NewGuid())
$install = Join-Path $env:LOCALAPPDATA 'Programs/Quest/bin'
New-Item -ItemType Directory -Path $work | Out-Null
try {
    Invoke-WebRequest "$base/$archive" -OutFile (Join-Path $work $archive)
    Invoke-WebRequest "$base/SHA256SUMS" -OutFile (Join-Path $work 'SHA256SUMS')
    $entries = @(Get-Content (Join-Path $work 'SHA256SUMS') | ForEach-Object {
        $fields = $_ -split '\s+', 2
        if ($fields.Count -eq 2 -and $fields[1].TrimStart('*') -eq $archive) { $fields[0] }
    })
    if ($entries.Count -ne 1 -or $entries[0] -notmatch '^[a-fA-F0-9]{64}$') { throw 'Missing or duplicate checksum' }
    if ((Get-FileHash (Join-Path $work $archive) -Algorithm SHA256).Hash -ne $entries[0]) { throw 'Checksum mismatch' }
    Expand-Archive (Join-Path $work $archive) -DestinationPath (Join-Path $work 'archive')
    & (Join-Path $work 'archive/quest.exe') --version
    if ($LASTEXITCODE -ne 0) { throw 'The downloaded binary did not run' }
    New-Item -ItemType Directory -Path $install -Force | Out-Null
    Copy-Item (Join-Path $work 'archive/quest.exe') (Join-Path $install 'quest.exe') -Force -ErrorAction Stop
} finally {
    Remove-Item -LiteralPath $work -Recurse -Force
}
$env:Path = "$install;$env:Path"
quest --version
```

The PATH change above lasts for this terminal only. Add the selected directory
to your user PATH through Windows Settings if you want future terminals to find
Quest. The archive install does not pin a repository's tool version; prefer its
existing tool manager when a shared pin is required.

From the repository root, follow [the setup instructions](../SETUP.md), or run
`quest init` to install the stubs and reference line, then `quest check`.
Both skill directories are real directories on new installs, so Git can track
them without symlink privileges. Existing conventional linked directories remain
supported. Setup preflights both destinations and refuses a user-owned skill
with the same name before writing anything. Uninstall recognizes unchanged
stubs with either LF or CRLF and preserves the instruction file's newline style.

## Agent workflows

Quest does not bundle or start an agent. Install the native tools separately:

- [Claude Code](https://code.claude.com/docs/en/setup#native-windows) supports
  native PowerShell and CMD on x64 and ARM64. Git for Windows is optional for
  its Bash/Monitor tools; native Windows agent sandboxing is currently not
  supported. Those are upstream tool limits, not Quest command requirements.
- [Codex on Windows](https://developers.openai.com/codex/windows) supports
  native PowerShell and Windows sandboxing. Follow its current device and
  enterprise-policy requirements.

The skills remain the same workflows. Claims and PR work need Git for Windows
and the appropriate GitHub credentials, and repository builds need that project's
own native toolchain. A repository requiring Nix or Linux-only checks still needs
its supported environment; installing Quest does not port the repository.
Parallel spawn depends on the foreground agent's subagent support.

## Update or remove

For mise, update or remove the repository's Quest entry with the same tool
manager. For an archive install, stop active Quest processes and replace
`quest.exe` with a verified newer archive.

Before removing the executable, follow [SETUP.md's removal workflow](../SETUP.md#remove)
to export active quests if requested and run `quest uninstall`. It removes
unmodified Quest stubs and its reference line, while retaining edited stubs,
custom skills, extra files, and all quest plans. Then delete only your installed
`quest.exe` and any user PATH entry you added. Delete `quest/` only when you
explicitly choose to discard it.

## Build and verify from source

[Bun](https://bun.sh) is required for a source build. From the checkout, run
`bun install --frozen-lockfile`, `bun run check`, `bun run test`, and
`bun run build`. Then run `bun scripts/lifecycle-check.mjs dist/quest.js`. The shared lifecycle checks
paths containing spaces, actual Git worktrees, CRLF plans/instructions, existing
custom skills, conflicts, and repeated setup/removal without remote writes.
Windows tests do not require symlink privileges; symlink-specific legacy cases
remain exercised on Linux/macOS. Use the Nix shell for the full Unix repository
checks; Nix itself is not required by native Quest users.

The release workflow [cross-compiles with Bun](https://bun.sh/docs/bundler/executables),
then verifies the PE architecture, archive checksum, version, and lifecycle on
each native Windows runner before publishing. The install-check workflow tests
fresh archive and mise installs after publishing. No tag or release is created
by an ordinary pull request.
