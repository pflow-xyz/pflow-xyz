# Deploying pflow.xyz

pflow.xyz is served by this repository's `cmd/webserver` on pflow.dev (port
8081, behind nginx; the service list and ports are in `CLAUDE.md`, section
"Deployment (pflow.dev)"). **There is no deploy pipeline outside the server.**
The server deploys itself: GitHub calls a webhook on every push to `main`, and
the running binary fetches, checks, builds and restarts itself. This page is how that works, what
holds a deploy back, how to tell why one did not happen, and the one piece of
box configuration it depends on.

Source: `cmd/webserver/deploy.go` (pipeline, handlers, status),
`cmd/webserver/deploy_gate.go` (the CI gate) and `deploy_proc_unix.go` (process
groups for the commands it runs). Tests: `deploy_test.go`, `deploy_gate_test.go`
and `deploy_git_test.go` (the pipeline against real git, a scratch origin and a
throwaway SSH signing key; it skips itself when `git`, `ssh-keygen` or `go` is
missing).

```bash
cd cmd/webserver && go test -race -count=1 -run 'Deploy|Gate|Webhook|RealGit' .
```

The whole package under `-race` needs `-timeout 30m` on a loaded Mac: the
default 10 minutes is not enough for the slow MCP game tests, which are not
related to the deploy.

## What happens on a push to main

```
GitHub push webhook ──► POST /webhook/github   (HMAC-checked, answers 202 at once)
manual              ──► POST /admin/deploy     (X-Deploy-Token, streams the output)
                              │
                              ▼  one deploy at a time (see "Queueing")
   1. git fetch origin refs/heads/main   then pin the fetched tip: sha = FETCH_HEAD
   2. git verify-commit <sha>      the tip must carry a signature the box trusts
   3. CI gate on <sha>             a successful `test` check run (GitHub API)
   4. git merge --ff-only <sha>    only now does the checkout change
   5. copy public/ to internal/static/, go build -o bin/webserver
   6. restart the service (~/services restart pflow-xyz), once the queue is empty
```

The **same sha** is verified, gated, merged and built. Nothing after step 1
names `origin/main`, so a push that lands mid-deploy cannot slip an unchecked
commit in between the check and the merge. The fetch names the full ref
(`refs/heads/main`) because a bare `main` is resolved by git's own rules, which
take a **tag** named `main` before the branch: anyone able to create a tag
could otherwise have chosen the commit that gets deployed. A deploy refused at step 2 or 3
has touched nothing: the checkout, `internal/static` and `bin/webserver` are
exactly as they were.

The webhook answers `202 deploy started` **before** doing any of this, so
GitHub's delivery list shows green for every delivery whether or not the deploy
worked. The outcome is in `GET /admin/deploy-status`.

### Endpoints

| Endpoint | Auth | What |
|---|---|---|
| `POST /webhook/github` | `X-Hub-Signature-256` HMAC with `DEPLOY_SECRET` | Push event. Other refs and `ping` are ignored (200). `main` answers 202 `deploy started`, 202 `deploy queued behind a running deploy`, or 202 `deploy queued; it supersedes the deploy that was waiting for CI`. **503** (`Retry-After: 10`) in the two seconds before the service restarts after a deploy: such a delivery would be lost with the process, so GitHub shows it failed and it can be redelivered. The webhook **never** skips the CI gate, whatever its URL says. |
| `POST /admin/deploy` | `X-Deploy-Token` header = `DEPLOY_SECRET` | Manual deploy; streams the output; waits its turn if one is running (503 in the restart window, as above). `?skip_ci=1` skips the CI gate only, and supersedes a deploy that is waiting for CI (see "Queueing"). |
| `GET /admin/deploy-status` | same token | The last attempt as JSON (below). |
| `GET /admin/logs?lines=N` | same token | The tmux pane of the service (what `[deploy]` lines went to). |
| `GET /health` | none | `{"ok":true}`, plus an `X-Build-Revision` response header: the git commit the running binary was built from (Go's `vcs.revision`; absent for a binary not built in a git checkout). |

Send the token in the `X-Deploy-Token` header. A `?token=` query parameter is
still accepted for old callers, but a query string is written to nginx's access
log and to shell history, so do not use it. The token is compared in constant
time, and `DEPLOY_SECRET` and `DEPLOY_GITHUB_TOKEN` are removed from the
environment of every command the deploy runs (git, bash, go).

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
| `DEPLOY_CI_POLL` | `15s` | Polling interval for the first 2 minutes; then twice that until 5 minutes, then four times (never slower than a minute, or this setting if that is longer). Go durations (`15s`, `1m`) or bare seconds. |
| `DEPLOY_CI_GRACE` | `2m` | How long a check run may take to appear after the push. |
| `DEPLOY_CI_TIMEOUT` | `15m` | The whole gate, polling included. |
| `DEPLOY_REPO` | from `git remote get-url origin` | `owner/repo` to ask GitHub about. |
| `DEPLOY_GITHUB_TOKEN` | none | **Recommended.** Bearer token for the API. The repo is public so it works without, but unauthenticated the gate spends one of GitHub's 60 requests an hour on every poll (see "Polling and the rate limit"). A token with **no scopes** (or a fine-grained token with read-only access to public repositories) is enough: 5000 requests an hour, and an unchanged answer (304) is free. |
| `DEPLOY_GITHUB_API` | `https://api.github.com` | API base (tests, GitHub Enterprise). |

## The signature check

`git verify-commit <sha>` must succeed. This is unchanged from before. The box's
git is configured with `gpg.format=ssh` and an `allowed_signers` file holding
the owner's SSH key, and its gpg keyring holds the owner's own keys. So the box
accepts:

- commits signed with the owner's SSH key (every commit made on valoper), and
- commits signed with any GPG key in the box's keyring.

It does **not** accept, until the key is imported (see "The ops fix"), commits
that GitHub itself creates: the **Merge pull request** and **Squash and merge**
buttons, and edits made in the web UI. GitHub signs those with its `web-flow`
key, `B5690EEEBB952194`. GitHub shows them as Verified; the box cannot check
them.

**Rebase and merge** is different: GitHub cannot sign the commits it rewrites
(it does not have the committer's key), so a tip made by that button arrives
**unsigned**, and importing GitHub's key does not help. `git verify-commit` says
nothing at all about an unsigned commit and exits 1; the deploy reads that
silence as "this commit carries no signature" and says so, with the advice to
use a merge commit or Squash and merge, or to merge and sign locally. (A
command killed by its timeout is silent too, but it does not exit 1 and is not
called unsigned.)

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
| the API's request budget is used up (`X-RateLimit-Remaining: 0`) and resets after the gate's deadline | **refuse** at once, naming `DEPLOY_GITHUB_TOKEN`, instead of waiting out the timeout |
| more matching check runs than the API sent (over 100) | **refuse**: the gate cannot know it saw a failing one |
| 401 (bad token), 404 (unknown or private repo), 422 (unknown sha) | **refuse** at once: retrying cannot fix it |
| still pending at `DEPLOY_CI_TIMEOUT` | **refuse** |

**Which check runs count.** A check name is only a label: a second workflow, or
any other GitHub App, can report a run called `test`. The gate asks for the
runs of **GitHub Actions** only (`app_id=15368`, `filter=all`), checks the app's
id and slug (`github-actions`) on every run in the answer, and ignores the
rest (the refusal says how many it ignored). A commit can have several check
suites with a job of that name (a push and a pull_request workflow on the same
sha, a second workflow); within a suite the newest run is the current attempt,
so a re-run supersedes the failure it re-ran, and **every suite must succeed**.
A finished non-success in any suite is final even if another is still running.
The gate counts GitHub Actions' runs only; if CI ever moves to another provider
the pinned app in `deploy_gate.go` has to change with it.

### Polling and the rate limit

Polling sends the response's `ETag` as `If-None-Match`. **Whether that saves
anything depends on authentication.** With a token GitHub answers an unchanged
poll with 304 and does not count it. Without one (the default) the check-runs
endpoint answers `200` every time with the same ETag (its response carries
`cache-control: public, max-age=60`), and every request counts: the second
review measured `x-ratelimit-remaining` going 56, 55, 54 on three polls, and a
real 304 on another unauthenticated endpoint decremented the counter too.
Unauthenticated, then, the gate spends one of GitHub's **60 requests an hour per
IP** on every poll. To keep that affordable:

- Polls back off: `DEPLOY_CI_POLL` (15s) for the first 2 minutes, twice that
  until 5 minutes, then four times (60s). A CI run that never finishes costs 25
  requests in the 15 minute gate, not the 61 a flat 15 seconds would. Two such
  runs in an hour still exhaust the budget.
- The gate reads `X-RateLimit-Remaining` and `-Reset` from every response and
  writes them to the deploy output: once (with a reminder that an
  unauthenticated gate spends a request per poll), on every poll once 10 or
  fewer are left, and in a summary line at the end.
- If the budget is gone and does not reset before the gate's deadline, the gate
  refuses **at once** with a message that names `DEPLOY_GITHUB_TOKEN`, instead of
  waiting out the timeout and refusing with a less useful one. A reset that
  comes before the deadline is waited for.
- **Set `DEPLOY_GITHUB_TOKEN`.** A token with no scopes is enough for a public
  repository, it raises the limit to 5000 an hour, and a 304 stops costing
  anything. Until it is set, a stuck CI run or a burst of pushes can use up the
  hour's budget and the deploys after that are refused.

Every decision is written to the deploy output and recorded in the status
(`ci_gate`: `passed`, `refused`, `skipped`, `disabled`, `superseded`;
`ci_run_url`).

Two ways around the gate, both loud in the output and the status:

- **`DEPLOY_REQUIRE_CI=0`** in `~/services`: the box stops gating (for example
  while the workflow is being renamed). Needs a service restart to take effect.
- **`POST /admin/deploy?skip_ci=1`** with the deploy token: one manual deploy
  without the gate, for an emergency. **The signature is still verified.** There
  is no equivalent for the webhook.

What the gate does not do: it does not run tests itself, and it does not report
back to GitHub (see "Follow-ups"). It trusts the GitHub Actions check run named
`test` on that sha. Only a GitHub App can create a check run through the API (a
user's or an OAuth app's token can read check runs but not write them), so a
person with write access cannot post a fake `test`. What they can do is change
what the real one runs: a workflow is code, and a pull request that edits
`.github/workflows/test.yml` is tested with its own edited workflow. The
protection is the review of changes under `.github/workflows/` and branch
protection on `main`, which is the repo's existing trust boundary; pinning the
app means a `test` reported by anything but GitHub Actions is not believed.

### What CI runs

`.github/workflows/test.yml`, job `test` (20 minute `timeout-minutes`: the gate
gives up after 15, and a hung test must not hold a runner for GitHub's default 6
hours): `make build` (which stages `public/`
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

**A deploy that is only waiting for CI is superseded**, not queued behind. When
the running deploy has fetched and verified its commit and is polling GitHub
with nothing to decide yet, a request that makes it obsolete ends the wait:

- `POST /admin/deploy?skip_ci=1`: an emergency override must not sit behind the
  wait it exists to override;
- a push webhook that announces a different commit than the one being polled: the
  poll is for a tip that is no longer the tip.

The waiting job ends in the state `superseded` (checkout untouched, nothing
judged: it is neither a refusal nor a failure) and the follow-up runs at once.
A repeat of the push being polled does not supersede it. A deploy whose CI is
already green is not interrupted, and one past the gate (merging, copying,
building) never is: a request then queues, and a skip request that finds a push
queued with it shares that follow-up with the gate **on** (fail closed); POST
`skip_ci=1` again once it is waiting to override.

**Restart window.** From the end of the last build until the process exits (about
two seconds) nothing is accepted: the webhook and `/admin/deploy` answer 503
with `Retry-After`, because anything queued then would die with the process.
GitHub shows the delivery as failed; redeliver it from the delivery list.

## Status

`GET /admin/deploy-status` (token required) returns the last attempt. It is kept
in memory and in `data/deploy-status.json` (gitignored with the rest of `data/`),
so it survives the restart that follows a successful deploy.

```json
{
  "state": "refused",            // idle | running | succeeded | failed | refused | superseded
  "trigger": "webhook",          // webhook | admin
  "announced_sha": "57f6caf...", // what the webhook payload said was pushed
  "sha": "57f6caf...",           // what was fetched, verified, gated, merged, built
  "step": "verify",              // current step, or the one it ended at
  "started_at": "...", "finished_at": "...",
  "error": "refusing to deploy 57f6caf...: its signature cannot be checked: ...",
  "ci_gate": "", "ci_run_url": "", // passed | refused | skipped | disabled | superseded
  "output_tail": "...",          // last 40 lines of the deploy output
  "queued": false,               // a follow-up is waiting
  "last_success": {"sha": "...", "finished_at": "..."},
  "running_build": {"revision": "...", "time": "..."}   // plus "modified": true when the tree was dirty
}
```

`refused` means policy said no (signature, CI gate) and nothing in the checkout
changed. `superseded` means a newer request ended the run while it was only
waiting for CI (nothing changed; the follow-up's attempt replaces it at once, so
you will mostly see it in the deploy output). `failed` means something broke
(fetch, merge, copy, build); the checkout may have moved. `last_success` is kept apart so a later refusal does
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
| status `refused`, error `the commit carries no signature` | The tip is unsigned. A **Rebase and merge** tip is: GitHub cannot sign rebased commits and importing its key does not help. Merge with a merge commit or Squash and merge, or merge and sign locally. |
| status `refused`, error `GitHub's API rate limit is used up` | The unauthenticated 60 requests an hour are spent (the output has the numbers). Set `DEPLOY_GITHUB_TOKEN` (no scopes needed), or `skip_ci=1`. |
| status `superseded` | A `skip_ci=1` request or a push of another commit ended a deploy that was only waiting for CI. The follow-up's attempt is the one to read. |
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
deploys run one at a time with a single queued follow-up; `/health` carries
the build revision so "main versus deployed" is checkable from outside; and a
push now waits for a green `test` check run before anything is built. The
**strictness did not change**: the box still refuses a commit it cannot verify,
and the code does not add web-flow (or anything) to its trust.

## The ops fix (NOT applied; for the owner to decide and run)

> **Nothing in this PR changes pflow.dev's keyring.** Until the owner does this
> (or merges only locally signed commits), a merge-button commit on `main` is
> refused by the deploy, now with a clear error.

> **Order matters: the first deploy after this PR merges is done by the OLD
> binary.** The service that receives that push's webhook was built before the
> merge, so it runs the old `runDeploySync`: no CI gate, the old error text, no
> status endpoint. Two things follow.
>
> 1. If you merge with GitHub's **merge button** (or squash), the tip is a
>    web-flow commit and the old binary refuses it unless the key is already in
>    the box's keyring. So run the import below **before** merging, or merge
>    this PR locally with a signed merge on valoper and push it.
> 2. Nothing checks CI for that first deploy, so the PR's own `pull_request` run
>    of the `test` job must be **green before you merge it**.
>
> From the second push on, the new binary is live and the gate applies.

Trusting web-flow means accepting any commit GitHub's merge-commit and squash
buttons (and web edits) create, i.e. whatever a GitHub account with merge rights
on the repo clicked: the box's gate becomes GitHub's access control for those
commits, plus the owner's SSH key for the rest. (It does not cover **Rebase and
merge**, whose commits GitHub cannot sign: that tip arrives unsigned and is
refused whatever the keyring holds.) The alternative is to keep the keyring as it
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

The whole deploy was also replayed with the real binary (built from a clean
clone, so it carries `vcs.revision`), real git and real gpg: a scratch origin
whose `main` is `57f6caf` (the web-flow-signed merge from the incident), a box
checkout at `eb0a490` (where pflow.dev stood), the box's git configuration
(`gpg.format=ssh`, an `allowed_signers` with only an unrelated key), an empty
throwaway `GNUPGHOME`, and a stand-in for the GitHub API on a local port. Each
line is one run of the webhook or `/admin/deploy`:

| Scenario | Result |
|---|---|
| web-flow tip, key not imported | refused with the web-flow message; box still at `eb0a490`; GitHub never asked |
| key imported, CI red | refused, `concluded "failure"` and the run URL; box unchanged |
| a failing GitHub Actions `test` next to a passing `test` from another app | refused on the Actions run; `ci_run_url` is the Actions run's |
| webhook with `?skip_ci=1` in its URL, CI red | refused: the webhook ignores it |
| webhook deploy waiting on a pending check, then `POST /admin/deploy?skip_ci=1` | the waiting deploy is superseded at once (the stream says so), the skip deploy builds, `ci_gate: skipped`, restart requested |
| a push of another commit while a deploy waits on a pending check | `202 deploy queued; it supersedes the deploy that was waiting for CI`; the follow-up deploys |
| origin has a **tag named `main`** (on `89e6f34`) and the branch is at `57f6caf` | deploys `57f6caf` (a bare `git fetch origin main` returns the tag's `89e6f34`) |
| origin hangs (accepts the connection, never answers) | `git fetch` is killed at its 2 minute limit, state `failed`, no `git` or `git-remote-http` process left, and the next delivery (origin repaired) deploys normally |
| deliveries during the two seconds before the restart | `503` with `Retry-After: 10`, then the process exits |
| green CI | fast-forward to `57f6caf`, build, restart requested, status persisted (`0600`) and read back by the fresh process, which also serves `X-Build-Revision` |

## Things that will surprise you

- **The first deploy after this change is done by the old binary.** The service
  that receives the webhook is the one that was built before the merge, with the
  old `deploy.go`: ungated, with the old error message. The gate, the status
  endpoint and the queue exist only from the second deploy on. So import the
  web-flow key **before** merging with the merge button (or merge locally with a
  signed merge), and merge only when the PR's own CI run is green (see the box
  at the top of "The ops fix").
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
- **A delivery in the restart window is answered 503.** The restart happens
  only after the queue is empty. A delivery that arrives in the two seconds
  between the last build and the process exiting would die with the old process,
  so it is refused with 503 (and `Retry-After`) rather than accepted and lost:
  GitHub's delivery list shows it failed, and you redeliver it.
- **Unauthenticated, the gate has 60 requests an hour.** Set
  `DEPLOY_GITHUB_TOKEN` (no scopes needed); see "Polling and the rate limit".

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
