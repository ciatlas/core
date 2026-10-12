# Security policy

Only the latest release receives fixes. Report vulnerabilities privately through
[GitHub's private vulnerability reporting](https://github.com/ciatlas/core/security/advisories/new), not in a public issue.

Core reads untrusted input: the workflow and action files of the repository it models. Relevant reports include
anything that lets that input read files outside the repository or inside `.git` (for example through symlinks),
exhaust memory or CPU disproportionately (YAML aliases, matrix size, symlink fan-out), or execute code. Tools built on
core, such as [flowpact](https://github.com/ciatlas/flowpact/security/policy), have their own policies.
