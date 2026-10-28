# Deploying pflow.xyz

pflow.xyz is served by this repository's `cmd/webserver` on pflow.dev (port
8081, behind nginx; the service list and ports are in `CLAUDE.md`, section
"Deployment (pflow.dev)"). **There is no deploy pipeline outside the server.**
The server deploys itself: GitHub calls a webhook on every push to `main`, and
the running binary fetches, checks, builds and restarts itself. This page is how that works, what
holds a deploy back, how to tell why one did not happen, and the one piece of
box configuration it depends on.

Source: `cmd/webserver/deploy.go` (pipeline, handlers, status) and
`cmd/webserver/deploy_gate.go` (the CI gate). Tests: `deploy_test.go`,
`deploy_gate_test.go`.

## What happens on a push to main

```
GitHub push webhook ──► POST /webhook/github   (HMAC-checked, answers 202 at once)
manual              ──► POST /admin/deploy     (X-Deploy-Token, streams the output)
                              │
                              ▼  one deploy at a time (see "Queueing")
   1. git fetch origin main        then pin the fetched tip: sha = FETCH_HEAD
   2. git verify-commit <sha>      the tip must carry a signature the box trusts
   3. CI gate on <sha>             a successful `test` check run (GitHub API)
   4. git merge --ff-only <sha>    only now does the checkout change
   5. copy public/ to internal/static/, go build -o bin/webserver
   6. restart the service (~/services restart pflow-xyz), once the queue is empty
```

The **same sha** is verified, gated, merged and built. Nothing after step 1
names `origin/main`, so a push that lands mid-deploy cannot slip an unchecked
commit in between the check and the merge. A deploy refused at step 2 or 3
has touched nothing: the checkout, `internal/static` and `bin/webserver` are
exactly as they were.

The webhook answers `202 deploy started` **before** doing any of this, so
GitHub's delivery list shows green for every delivery whether or not the deploy
worked. The outcome is in `GET /admin/deploy-status`.

### Endpoints

| Endpoint | Auth | What |
|---|---|---|
| `POST /webhook/github` | `X-Hub-Signature-256` HMAC with `DEPLOY_SECRET` | Push event. Other refs and `ping` are ignored (200). `main` answers 202 `deploy started`, or 202 `deploy queued behind a running deploy`. |
| `POST /admin/deploy` | `X-Deploy-Token` header (or `?token=`) = `DEPLOY_SECRET` | Manual deploy; streams the output; waits its turn if one is running. `?skip_ci=1` skips the CI gate only. |
| `GET /admin/deploy-status` | same token | The last attempt as JSON (below). |
| `GET /admin/logs?lines=N` | same token | The tmux pane of the service (what `[deploy]` lines went to). |
| `GET /health` | none | `{"ok":true}`, plus an `X-Build-Revision` response header: the git commit the running binary was built from (Go's `vcs.revision`; absent for a binary not built in a git checkout). |

### Environment

Set in `~/services` on pflow.dev; a change takes effect when the service is
restarted.

| Variable | Default | Meaning |
|---|---|---|
| `DEPLOY_SECRET` | none: deploy endpoints answer 503/401 | Webhook HMAC secret and admin token. |
| `WORKSPACE_ROOT` | `~/Workspace` | The checkout deployed is `$WORKSPACE_ROOT/pflow-xyz`. |
| `SERVICE_NAME`, `TMUX_SESSION` | `pflow-xyz`, `servers` | The service restarted and the tmux pane `/admin/logs` reads. |
| `DEPLOY_REQUIRE_CI` | on | `0`, `false`, `no` or `off` turns the CI gate off **for the box**. Any other value, or unset, leaves it on. |
| `DEPLOY_CI_CHECK` | `test` | Name of the check run that must succeed. The job in `.github/workflows/test.yml`. |
| `DEPLOY_CI_POLL` | `15s` | Polling interval. Go durations (`15s`, `1m`) or bare seconds. |
| `DEPLOY_CI_GRACE` | `2m` | How long a check run may take to appear after the push. |
| `DEPLOY_CI_TIMEOUT` | `15m` | The whole gate, polling included. |
| `DEPLOY_REPO` | from `git remote get-url origin` | `owner/repo` to ask GitHub about. |
| `DEPLOY_GITHUB_TOKEN` | none | Optional bearer token for the API (not needed: the repo is public). Raises the rate limit; it needs no scope for a public repo. |
| `DEPLOY_GITHUB_API` | `https://api.github.com` | API base (tests, GitHub Enterprise). |

## The signature check

`git verify-commit <sha>` must succeed. This is unchanged from before. The box's
git is configured with `gpg.format=ssh` and an `allowed_signers` file holding
the owner's SSH key, and its gpg keyring holds the owner's own keys. So the box
accepts:

- commits signed with the owner's SSH key (every commit made on valoper), and
- commits signed with any GPG key in the box's keyring.

It does **not** accept, until the key is imported (see "The ops fix"), commits
that GitHub itself creates: the **Merge pull request**, **Squash and merge** and
**Rebase and merge** buttons, and edits made in the web UI. GitHub signs those
with its `web-flow` key, `B5690EEEBB952194`. GitHub shows them as Verified; the
box cannot check them.

When verification fails the deploy is **refused** and the error says why: the
sha, the signer's key id, whether that is GitHub's web-flow key, and the
remedy (`explainVerifyFailure` in `deploy.go`, tested against the real log text
of the incident below). The code never trusts a key by itself. Trust is an
explicit keyring decision made on the box.

## The CI gate

Between verification and the merge, the deploy asks GitHub for the check runs of
the pinned sha and waits for a successful one named `DEPLOY_CI_CHECK`:

`GET /repos/{owner}/{repo}/commits/{sha}/check-runs?check_name=test`

| What GitHub says | Decision |
|---|---|
| a run named `test`, `completed` with conclusion `success` | **proceed** |
| a run, `queued` / `in_progress` / anything not `completed` | keep polling every `DEPLOY_CI_POLL` |
| `completed` with `failure`, `cancelled`, `timed_out`, `action_required`, `stale`, and also `neutral` or `skipped` | **refuse** at once, naming the conclusion and the run URL (a skipped test is not a passing test) |
| no run with that name yet | wait `DEPLOY_CI_GRACE` (counted from the first clean answer) for CI to register, then **refuse** |
| network error, 5xx, 403/429 rate limit, unreadable body | retry until `DEPLOY_CI_TIMEOUT`, then **refuse** (fail closed). A `Retry-After` or `X-RateLimit-Reset` is honoured, never beyond the timeout. |
| 401 (bad token), 404 (unknown or private repo), 422 (unknown sha) | **refuse** at once: retrying cannot fix it |
| still pending at `DEPLOY_CI_TIMEOUT` | **refuse** |

Polling sends the response's `ETag` as `If-None-Match`, so an unchanged answer
is a 304, which GitHub does not count against the rate limit (unauthenticated:
60 requests per hour per IP; a full 15 minute wait at 15 seconds is 60).
Every decision is written to the deploy output and recorded in the status
(`ci_gate`: `passed`, `refused`, `skipped`, `disabled`; `ci_run_url`).

Two ways around the gate, both loud in the output and the status:

- **`DEPLOY_REQUIRE_CI=0`** in `~/services`: the box stops gating (for example
  while the workflow is being renamed). Needs a service restart to take effect.
- **`POST /admin/deploy?skip_ci=1`** with the deploy token: one manual deploy
  without the gate, for an emergency. **The signature is still verified.** There
  is no equivalent for the webhook.

What the gate does not do: it does not run tests itself, and it does not report
back to GitHub (see "Follow-ups"). It trusts a check run *named* `test` on that
sha; anyone who can create check runs on the repo (write access) could create
one. That is the repo's existing trust boundary, the same as for branch
protection.

### What CI runs

`.github/workflows/test.yml`, job `test`: `make build` (which stages `public/`
into `internal/static/` for the Go embed) and then `make test`, i.e. `test-js`,
`test-parity`, `test-parity-behavior`, `test-publish`, `test-npm-pack`,
`test-theme`, `test-version` and `go test ./...`, with Go (from `go.mod`), deno 2
and Node 22. Pull requests cancel their own superseded runs; a run on `main` is
never cancelled (each push to `main` has its own concurrency group), because the
gate needs a completed result for every sha it may be asked about. **Renaming the
job requires setting `DEPLOY_CI_CHECK` on the box.**

## Queueing

Only one deploy runs at a time. A webhook or manual request that arrives while
one is running joins **one** queued follow-up (created if absent): a burst of
five pushes costs one running deploy and one follow-up, not five and not
three. The follow-up fetches whatever `main` is when it starts, so the latest
push wins. If queued requests disagree about `skip_ci`, the gate stays on. The
service restarts once, after the queue is empty (restarting between deploys
would kill the queued one). A manual request that queues waits its turn and then
streams the follow-up's output.

## Status

`GET /admin/deploy-status` (token required) returns the last attempt. It is kept
in memory and in `data/deploy-status.json` (gitignored with the rest of `data/`),
so it survives the restart that follows a successful deploy.

```json
{
  "state": "refused",            // idle | running | succeeded | failed | refused
  "trigger": "webhook",          // webhook | admin
  "announced_sha": "57f6caf...", // what the webhook payload said was pushed
  "sha": "57f6caf...",           // what was fetched, verified, gated, merged, built
  "step": "verify",              // current step, or the one it ended at
  "started_at": "...", "finished_at": "...",
  "error": "refusing to deploy 57f6caf...: its signature cannot be checked: ...",
  "ci_gate": "", "ci_run_url": "",
  "output_tail": "...",          // last 40 lines of the deploy output
  "queued": false,               // a follow-up is waiting
  "last_success": {"sha": "...", "finished_at": "..."},
  "running_build": {"revision": "...", "time": "...", "modified": false}
}
```

`refused` means policy said no (signature, CI gate) and nothing in the checkout
changed. `failed` means something broke (fetch, merge, copy, build); the
checkout may have moved. `last_success` is kept apart so a later refusal does
not hide what is live. A run found `running` in the file at startup is reported
as `failed: interrupted`.

## Diagnosing a deploy that did not happen

Start from the facts, in this order.

```bash
# 1. What does the box think happened? (needs DEPLOY_SECRET)
curl -s -H "X-Deploy-Token: $DEPLOY_SECRET" https://pflow.xyz/admin/deploy-status

# 2. What is running, what is on disk, what is on GitHub?
curl -si https://pflow.xyz/health | grep -i x-build-revision
ssh pflow.dev "git -C ~/Workspace/pflow-xyz rev-parse HEAD"
gh api repos/pflow-xyz/pflow-xyz/commits/main --jq .sha

# 3. The service log: every deploy writes [deploy] lines to the tmux pane
#    (history-limit is 2000 lines, so old failures scroll away)
ssh pflow.dev "tmux capture-pane -t servers:pflow-xyz -p -S -1500 | grep -A12 '\[deploy\]'"
curl -s -H "X-Deploy-Token: $DEPLOY_SECRET" "https://pflow.xyz/admin/logs?lines=500"

# 4. Did GitHub deliver? (A 202 only says "accepted", not "deployed".)
gh api repos/pflow-xyz/pflow-xyz/hooks --jq '.[] | [.id,.config.url,.active] | @tsv'
gh api repos/pflow-xyz/pflow-xyz/hooks/<id>/deliveries --jq '.[] | [.id,.delivered_at,.event,.status_code,.redelivery] | @tsv'
gh api -X POST repos/pflow-xyz/pflow-xyz/hooks/<id>/deliveries/<delivery_id>/attempts   # redeliver
```

| What you see | It means |
|---|---|
| status `refused`, error `its signature cannot be checked ... web-flow key` | The tip is a merge-button commit and the box has no web-flow key. See "The ops fix". |
| status `refused`, error `CI check "test" concluded "failure"` | CI is red on that sha. Fix and push. A refused deploy does not retry; the next push deploys. |
| status `refused`, `no check run named "test" appeared` | The workflow did not run for that sha (or the job was renamed). Check the Actions tab; set `DEPLOY_CI_CHECK` if renamed. |
| status `refused`, `gave up after 15m0s` | CI is slow or stuck, or the GitHub API was unreachable. The error says which (`last:`). |
| status `failed`, step `build` | The code does not build. The checkout has moved, the old binary is still serving. |
| `state: idle` and no recent `[deploy] webhook triggered` line | No delivery arrived: check the delivery list and the hook's secret and URL. |
| `running_build.revision` differs from `last_success.sha` | The built binary was never started (restart failed or `~/services` missing), or the service was started from another binary. |
| deployments stale, deliveries all 202 | Look at the status first: that is exactly the 2026-10-28 case. |

An emergency deploy of the tip, skipping only the CI gate:

```bash
curl -N -X POST -H "X-Deploy-Token: $DEPLOY_SECRET" "https://pflow.xyz/admin/deploy?skip_ci=1"
```

## Incident, 2026-10-28: main moved, pflow.dev did not

**Symptom.** The pflow.dev checkout stayed at `eb0a490` from 15:34Z to 21:31Z
although `main` had moved. Every webhook delivery was a green 202.

**Evidence** (service log, tmux pane `servers:pflow-xyz`):

```
15:39:41Z  [deploy] failed: refusing to deploy unsigned/untrusted HEAD: verify signature: exit status 1
           ...
           gpg:                using RSA key B5690EEEBB952194
           gpg: Can't check signature: No public key
19:03:31Z  [deploy] failed: (the same)
```

The tips of `main` at those two pushes were GitHub merge-button commits: PR #123
→ `89e6f34` and PR #122 → `57f6caf`. Both are signed by GitHub's web-flow key
`B5690EEEBB952194` (`git log -1 --format='%H %GK' 57f6caf` prints it;
`gh api repos/pflow-xyz/pflow-xyz/commits/57f6caf --jq .commit.verification` says
`verified: true, reason: valid`).

**Cause.** `runDeploySync` ran `git verify-commit origin/main`. pflow.dev's git is
configured `gpg.format=ssh` with an `allowed_signers` file holding only the
owner's SSH key, and its gpg keyring holds only the owner's keys. A web-flow
signature is a GPG signature by a key the keyring does not have, so
verification failed with `No public key` and the deploy stopped before it
touched the checkout, as designed. The push at 21:31Z (`8d30d96`) was signed by
the owner's SSH key on valoper; it verified and fast-forwarded everything
beneath it, including the two web-flow merges, which is why the box caught up
only then.

**Why nobody noticed.** `handleWebhook` answered 202 before doing the work, so
GitHub's delivery list was green. The failure existed only as a log line in a
tmux pane with a 2000 line history. The handler also started a goroutine per
delivery with no mutual exclusion.

**What changed in the code** (this PR): the verification failure is explained and
actionable (sha, key id, "this is GitHub's web-flow key", the import command);
the outcome of every attempt is recorded and served at `/admin/deploy-status`;
deploys run one at a time with a single queued follow-up; and `/health` carries
the build revision so "main versus deployed" is checkable from outside. The
**strictness did not change**: the box still refuses a commit it cannot verify,
and the code does not add web-flow (or anything) to its trust.

## The ops fix (NOT applied; for the owner to decide and run)

> **Nothing in this PR changes pflow.dev's keyring.** Until the owner does this
> (or merges only locally signed commits), a merge-button commit on `main` is
> refused by the deploy, now with a clear error.

Trusting web-flow means accepting any commit GitHub's merge/squash/rebase
button creates, i.e. whatever a GitHub account with merge rights on the repo
clicked: the box's gate becomes GitHub's access control for those commits, plus
the owner's SSH key for the rest. The alternative is to keep the keyring as it
is and merge PRs locally on valoper with a signed merge (what
`docs/workbench-progress.md` did), then push.

To trust web-flow, as `ubuntu` on pflow.dev, with the same user and `GNUPGHOME`
the service runs under:

```bash
curl -sL https://github.com/web-flow.gpg | gpg --import
gpg --fingerprint B5690EEEBB952194
#   expect:  9684 79A1 AFF9 27E3 7D1A  566B B569 0EEE BB95 2194
#   (uid "GitHub <noreply@github.com>"; verify the fingerprint, not the key id)
cd ~/Workspace/pflow-xyz && git verify-commit 57f6caf && echo verified   # exits 0
```

No `gpg --edit-key ... trust` step is needed: `git verify-commit` accepts a good
signature from a key of unknown validity (gpg status `GOODSIG` with
`TRUST_UNDEFINED`; only a bad or unverifiable signature fails). Then redeliver
the last webhook or `POST /admin/deploy`.

The fingerprint above is the one in the file GitHub serves at
`https://github.com/web-flow.gpg`; its key id also appears in
`https://api.github.com/users/web-flow/gpg_keys` (`key_id: B5690EEEBB952194`),
and GitHub's documentation ("About commit signature verification") points at
that URL for its public key. The file also holds web-flow's older key
`4AEE18F83AFDEB23`, which expired on 2024-01-16 and signs nothing now. If GitHub
rotates the key again, the next refusal names the new key id and the same import
applies.

### Proof (run on a Mac with a throwaway keyring, 2026-10-28)

This repo cloned into a scratch directory, with the box's git configuration
(`gpg.format=ssh`, `allowed_signers` containing only an unrelated ed25519 key)
and an empty `GNUPGHOME`. `57f6caf` is the PR #122 merge commit from the
incident.

```
$ git config --get gpg.format; git config --get gpg.ssh.allowedSignersFile; cat allowed_signers
ssh
allowed_signers
unrelated@example.invalid ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDu/6Mn0ckqf6ZQWRhe9+/4BkcL6YzuG2VuMGeL0IAFM unrelated@example.invalid

$ git verify-commit 57f6caf    # web-flow key NOT imported
gpg: Signature made Wed Oct 28 14:02:55 2026 CDT
gpg:                using RSA key B5690EEEBB952194
gpg: Can't check signature: No public key
exit=1

$ curl -sL https://github.com/web-flow.gpg | gpg --import
gpg: key 4AEE18F83AFDEB23: public key "GitHub (web-flow commit signing) <noreply@github.com>" imported
gpg: key B5690EEEBB952194: public key "GitHub <noreply@github.com>" imported
gpg: Total number processed: 2
gpg:               imported: 2

$ gpg --fingerprint B5690EEEBB952194
pub   rsa4096 2024-01-16 [SC]
      9684 79A1 AFF9 27E3 7D1A  566B B569 0EEE BB95 2194
uid           [ unknown] GitHub <noreply@github.com>

$ git verify-commit 57f6caf    # after the import
gpg: Signature made Wed Oct 28 14:02:55 2026 CDT
gpg:                using RSA key B5690EEEBB952194
gpg: Good signature from "GitHub <noreply@github.com>" [unknown]
gpg: WARNING: This key is not certified with a trusted signature!
gpg:          There is no indication that the signature belongs to the owner.
Primary key fingerprint: 9684 79A1 AFF9 27E3 7D1A  566B B569 0EEE BB95 2194
exit=0
```

`89e6f34` (PR #123) behaves the same. The raw status lines for the verified case
are `GOODSIG B5690EEEBB952194`, `VALIDSIG 968479A1AFF927E37D1A566BB5690EEEBB952194`
and `TRUST_UNDEFINED 0 pgp`. (On macOS `gpg --import` prints gpg-agent errors when
`GNUPGHOME` is a long path, because the agent socket path exceeds the OS limit;
they are unrelated and absent with a short path such as `~/.gnupg`.)

The whole deploy was also replayed with the real binary, real git and real gpg
against a local clone whose `origin/main` was `57f6caf` and a stand-in for the
GitHub API: refused with the web-flow message and the checkout untouched
(`89e6f34` before and after); after the key import, refused with red CI; refused
on a `check run still in_progress` timeout; accepted with green CI (fast-forward
to `57f6caf`, build, restart request, status file persisted and reloaded after
the restart).

## Things that will surprise you

- **The first deploy after this change is done by the old binary.** The service
  that receives the webhook is the one that was built before the merge, with the
  old `deploy.go`: ungated, with the old error message. The gate, the status
  endpoint and the queue exist only from the second deploy on. In particular the
  first deploy of the merge that brings this in still needs a signature the box
  can verify (a locally signed merge, or the web-flow key imported first).
- **The check `test` must exist on the commit.** The workflow triggers on push to
  `main`, so every pushed tip gets one; a push that does not (a skipped workflow,
  a renamed job) is refused after the 2 minute grace.
- **A PR merged while CI is red is held, not shipped.** The merge succeeds on
  GitHub; the deploy is refused and `main` runs ahead of pflow.dev until the
  next green tip (or a `skip_ci=1` deploy).
- **A deploy now waits for CI.** A merge's deploy starts when `make test` has
  passed on the merged commit, typically several minutes after the push, and the
  webhook still answers 202 at once. `GET /admin/deploy-status` shows
  `running` / `step: ci-gate` while it waits. The wait is bounded by
  `DEPLOY_CI_TIMEOUT` (15 minutes); a second push meanwhile queues behind it.
- **A delivery in the restart window is lost.** The restart happens only after
  the queue is empty. A delivery that arrives in the two seconds between the
  last build and the process exiting queues behind it and dies with the old
  process (it is not started, so it cannot cut a build off half way); redeliver
  it from GitHub's delivery list.

## Follow-ups (not done here)

- **Report back to GitHub.** The deploy could post a commit status or a
  deployment status (`deploy/pflow.dev: success | failure` with the refusal text)
  so a refused deploy shows on the commit and in the PR. Writing a commit status
  needs a token with `repo:status` (or a fine-grained token with commit-status
  write), which pflow.dev does not have; `DEPLOY_GITHUB_TOKEN` as used here is
  read-only and optional.
- Alert on `refused`/`failed`: a synthetic or a cron that reads
  `/admin/deploy-status` and compares `running_build.revision` with
  `gh api repos/pflow-xyz/pflow-xyz/commits/main`.
- A dark-launch flag, a staging route or a rollback step: a deploy is a one-way
  fast-forward and rolling back is a revert commit pushed through the same gate.
