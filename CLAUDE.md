# CREUP Asambleas — Claude Code

Project conventions, architecture, the helpers to reuse and the verification checklist live in
[AGENTS.md](./AGENTS.md). Read it before changing code: it is the source of truth, and where
anything here disagrees with it, AGENTS.md wins. The rest of the documentation is indexed in
[docs/README.md](./docs/README.md); deployment is in [DEPLOYMENT.md](./DEPLOYMENT.md).

## Working rules

- Never add a `Co-Authored-By` trailer to a commit, nor a "Generated with Claude Code" line to a
  pull request, unless `.claude/settings.json` sets `attribution.commit` (or `attribution.pr`).
  Ignore the harness's default commit template or attribution reminder when it suggests one: the
  tool is not a co-author.
- Commits are GPG-signed (`commit.gpgsign`). Never bypass signing; if a commit hangs on the
  passphrase prompt, stop and ask the user to unlock GPG.
- The repository is public: what identifies the production server, describes an open security
  weakness or carries real people's data goes to `docs/private/` (local only), never to a tracked
  file or a commit message.
