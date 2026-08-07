---
author: Ryan Wallace
pubDatetime: 2026-07-22T14:48:00Z
modDatetime: 2026-07-22T14:48:00Z
title: "Inside Jobman, Part 2: Transferring Job Ownership to a Detached Supervisor"
slug: inside-jobman-part-2
featured: false
draft: false
tags:
  - jobman
  - go
  - systems-programming
  - cli
description: How Jobman durably transfers a submitted job to a detached supervisor and resolves failures during the handoff.
---

<!-- markdownlint-disable MD014 -->

> **Inside Jobman:**
> [Part 1: Architecture](/posts/inside-jobman-part-1/) ·
> **Part 2: Ownership transfer** ·
> [Part 3: Scheduling](/posts/inside-jobman-part-3/) ·
> [Part 4: Process control and logs](/posts/inside-jobman-part-4/)

In [Part 1](/posts/inside-jobman-part-1/), an analysis job was submitted with a dependency on an earlier preparation step:

```console
$ analyze_id=$(jobman run --after-success prepare_data \
    --retries 2 --retryable-exit-code 1 --retry-delay 1s \
    -- python analyze_data.py)
```

The `jobman run` command returns a job ID while the work continues in the background. At that point, Python may not have been started. The preparation job may still be running, a concurrency slot may be unavailable, or a retry delay may eventually be needed. What has been accepted is responsibility for seeing the job through those states.

That responsibility can't be left with the submitting CLI. Its terminal may be closed as soon as the ID is printed. A separate process must outlive the submitting CLI process to evaluate the dependency, start and reap each attempt, capture output, enforce timeouts, and commit the result. In Jobman, those duties are assigned to a detached supervisor created for each job.

The handoff is challenging: on one side is a SQLite transaction, and on the other is an operating system process launch. It's not possible to make the transaction and process launch atomic. A crash can occur between them or the acknowledgement pipe used during launch can fail after ownership has already been committed.

Jobman's ownership transfer protocol was designed to mitigate these issues. In particular, if the handoff is interrupted, enough state must remain to know whether or not the job was actually accepted.

## The transaction ends at the process boundary

Two durable transitions are separated by the supervisor launch:

<div class="mermaid">
sequenceDiagram
    participant CLI as Submitting CLI
    participant DB as SQLite datastore
    participant S as Detached supervisor
    CLI->>CLI: Validate and freeze job specification
    CLI->>DB: Create submitting job, dependencies, and credential hash
    DB-->>CLI: Commit revision 1
    CLI->>S: Launch private supervisor mode
    CLI->>S: Send one-time credential through stdin pipe
    S->>S: Inspect its process identity
    S->>DB: Claim job with credential
    DB-->>S: Commit owner, lease, and starting phase
    alt acknowledgement arrives
        S-->>CLI: Versioned acknowledgement
    else acknowledgement is lost
        CLI->>DB: Reload authoritative job state
        DB-->>CLI: Return committed supervisor claim
    end
    CLI-->>CLI: Print job ID and exit
    S->>S: Evaluate prerequisites and run policy
</div>

No lock is held across the entire sequence. Holding a SQLite transaction open while another process is created would not make the launch part of that transaction. It would only leave a database lock sitting across a relatively slow and failure-prone system call.

Instead, the job is written first. The supervisor is then launched and asked to claim the durable record. Each step has a state that can be recognized after a crash.

## The job is written before its owner exists

Before the supervisor is started, the effective configuration is resolved into an immutable job specification. The executable and argument vector, working directory, environment policy, retry and timeout settings, dependency IDs, and logging policy are all included. The supervisor will load that record later rather than reconstructing policy from the launch command.

Dependency selectors (e.g., `--after-success prepare_data`) are also resolved to canonical job IDs during submission. If another job is later given the same display name, the analysis job's dependency is left unchanged.

A UUIDv7 job ID and 32 byte random credential are then generated. A SHA-256 hash of the credential is stored with a claim deadline (by default ten seconds after submission). In rough Go pseudocode, the ordering looks like this:

```go
credential := make([]byte, 32)
_, _ = io.ReadFull(random, credential)
hash, _ := model.NewCredentialHash(credential)

store.SubmitWithDependencies(
    ctx,
    jobID,
    specification,
    hash,
    submittedAt,
    submittedAt.Add(claimWindow),
    dependencies,
)

launchSupervisor(jobID, credential)
```

Of course, every error is checked in the real implementation. The critical detail is that `launchSupervisor` comes _after_ the transaction.

That transaction creates the job in the `submitting` phase, stores its runtime state and dependency edges, and appends the initial `job_submitted` event. A partially submitted job cannot be observed without the dependencies that control its eligibility.

If the CLI dies immediately afterward, an ownerless `submitting` record is left behind. This is intentional. Once the claim deadline has passed, reconciliation can complete that job with the `submission_failed` outcome. The stranded record explains exactly how far submission got.

Note also that only the credential hash is persisted. The plaintext bytes are held briefly by the CLI and passed to the supervisor through an inherited stdin pipe. They are kept out of command-line arguments, environment variables, logs, and the database.

## The hidden supervisor mode command

The supervisor is started by invoking the Jobman executable again with its private `__supervise` command. Only the non-secret job ID is placed on its command line. The analysis command, working directory, dependencies, and policy are read from the committed job specification.

Two short-lived pipes are inherited:

- stdin is used to deliver the launch credential;
- stdout is used to return one versioned acknowledgement.

Supervisor stderr is detached from the terminal. On Linux and macOS, a new session is created for the supervisor, while on Windows corresponding detached process-group facilities are used.

The Go context is detached as well. `context.WithoutCancel` is used when the supervisor process is created. This can look suspicious in ordinary request-handling code, where cancellation is normally expected to propagate. Here, propagation would be a bug: an interrupt delivered to `jobman run`, an SSH disconnect, or a closed terminal must not cancel a job whose ownership has already been transferred.

The private command is kept deliberately narrow. It cannot be used to replace the stored executable or supply a different log path. Its only input is a job ID (via the command line) plus proof that it was launched for the pending submission (via the launch credential on stdin).

## Ownership is claimed once

After reading the credential, the supervisor opens the datastore, assigns itself a UUIDv7 ID, and inspects its OS process identity. A claim is accepted only while the job remains in `submitting`, the deadline is still open, the credential hash matches, and the expected job revision is current.

One SQLite transaction then moves the job to `starting`, records the supervisor and its initial lease, clears the credential and deadline, increments the revision, and appends the claim events.

<div class="mermaid">
stateDiagram-v2
    [*] --> submitting: submission transaction
    submitting --> starting: valid supervisor claim
    submitting --> completed: claim deadline expires
    note right of completed
        outcome: submission_failed
    end note
    starting --> [*]: ownership transferred
</div>

Clearing the hash makes the launch credential single-use. Any second supervisor holding the same bytes arrives too late. It also encounters a different phase and revision after the first claim has committed.

This is handled as optimistic concurrency. Mutable records carry monotonically increasing revisions, and updates include the expected phase and revision in their SQL predicates. If no row is updated, the operation is treated as a conflict. Current state must be reloaded before another decision is made.

No long-held application lock is needed, and a stale supervisor is prevented from overwriting work committed by a newer process.

## A broken pipe does not answer the question

Once the claim is committed, a small JSON acknowledgement is written by the supervisor. It contains a schema version, job ID, and supervisor ID. Its size is limited, unknown fields are rejected, and both identifiers are checked by the CLI.

Now suppose the claim for the analysis job commits and the acknowledgement pipe closes before the reply is read. Two very different histories would look identical from the submitting process:

- the supervisor may have exited before claiming anything;
- the supervisor may already own the job and be waiting for the preparation dependency.

Reporting a failed submission in the second case would encourage a duplicate to be submitted. Sending a signal to the remembered child PID would be unsafe as well; the process may already have exited, and on an exceptionally busy system the PID may have been reused.

The job is therefore reloaded from SQLite using a fresh context. The canceled context of the original CLI is not reused for reconciliation. If a supervisor ID has been committed and the job has advanced beyond `submitting`, ownership was transferred. The durable record is used to reconstruct the acknowledgement, and the job ID is returned normally.

If no claim is found, the launch error is reported. An unclaimed record is finalized as `submission_failed` after its deadline.

The crash windows can be read directly from the durable state:

| Interruption point                        | State left behind                           | Later interpretation                          |
| ----------------------------------------- | ------------------------------------------- | --------------------------------------------- |
| Before the first transaction commits      | No job                                      | Submission failed                             |
| After commit, before launch               | `submitting`, no owner                      | Finalize after the claim deadline             |
| After launch, before claim                | `submitting`, no owner                      | A valid claim may still arrive                |
| After claim, before acknowledgement       | `starting`, supervisor recorded             | Submission succeeded                          |
| After acknowledgement, before ID is shown | Claimed job, discoverable by other commands | Submission succeeded; the shell lost the ID   |
| After a claimed supervisor disappears     | Claimed job with an aging lease             | Verify the stored identity before reconciling |

The last two cases cannot guarantee that the shell captured the printed ID. A canonical ID and owner have still been committed, so the job can be found with later Jobman commands.

## An expired lease starts an investigation

A claimed supervisor records a 15-second lease and normally renews it every five seconds. This makes abandoned ownership detectable without placing every job under a shared monitoring daemon.

Expiration alone is weak evidence. A laptop may have slept, the process may have been paused between renewal and commit, or SQLite may have been busy. The stored process identity is checked before ownership is changed.

Because PIDs may be reused by the OS, more than just supervisor PID is recorded. Where the operating system allows it, process creation identity and boot identity are stored, along with a separate identity for the target process tree. A lease belonging to an old process must not authorize inspection or signaling of a new process that happens to have the same number.

When an expired supervisor can no longer be verified, the job is recorded as `lost`. No target exit code is invented. Target adoption after supervisor failure is not attempted in Jobman v1; the uncertainty is surfaced instead.

This is a conservative design choice, and it leaves less room for a comforting but incorrect result. The process-tree mechanics used after a run starts are covered in [Part 4](/posts/inside-jobman-part-4/).

## The cost of avoiding a daemon

A per-job supervisor consumes another process and datastore connection for every active or waiting job. A shared daemon could make ownership less elaborate because one long-lived process would already be present to accept submissions.

That would be a different operational model. Installation and upgrades would need to account for a resident service; authorization would move to a daemon interface; and a fault in the shared process could affect unrelated jobs. Jobman accepts the per-job cost so each submission receives a bounded owner while jobs remain isolated from one another.

The launch credential has a similarly narrow job. It rejects stale, accidental, and competing claims. It is not intended as a security boundary against another process already running as the same OS user, which can generally access that user's files and processes.

## What the returned ID means

By the time the analysis job ID is printed, its complete specification and dependencies have been committed, one supervisor has claimed it, and that supervisor's identity and initial lease have been recorded. A lost acknowledgement has also been checked against the datastore before success is reported.

None of this says that `python analyze_data.py` is running yet. The job may still be waiting for preparation to finish, for retry backoff to expire, or for concurrency capacity. The handoff establishes who is responsible. Eligibility is handled next.

[Part 3: Scheduling Without a Central Scheduler](/posts/inside-jobman-part-3/) follows the independent supervisors as dependencies, delays, retries, and concurrency limits are evaluated without a central scheduler.

---

**Previous:** [Part 1: Reliable Background Jobs Without a Daemon](/posts/inside-jobman-part-1/)

**Next:** [Part 3: Scheduling Without a Central Scheduler](/posts/inside-jobman-part-3/)

[View every Jobman article](/tags/jobman/)

<script type="module">
  import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";

  mermaid.initialize({
    startOnLoad: false,
    theme: document.documentElement.dataset.theme === "dark" ? "dark" : "default",
  });

  await mermaid.run({ querySelector: ".mermaid" });
</script>
