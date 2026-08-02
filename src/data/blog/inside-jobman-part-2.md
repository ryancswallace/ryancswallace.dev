---
author: Ryan Wallace
pubDatetime: 2026-08-02T14:48:00Z
modDatetime: 2026-08-02T14:48:00Z
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

In [Part 1](/posts/inside-jobman-part-1/), I submitted an analysis job that depended on an earlier preparation step:

```console
$ analyze_id=$(jobman run --after-success "$prepare_id" \
    --retries 2 --retryable-exit-code 1 --retry-delay 1s \
    -- python analyze_data.py)
```

The command prints a job ID and exits while the analysis continues in the background. That looks like an ordinary process launch, but the important operation is not starting Python. It is transferring responsibility for the job to another process.

After the submitting CLI exits, something still has to wait for the dependency, acquire concurrency capacity, start and reap each attempt, capture its output, enforce timeouts, and commit the final result. Jobman assigns that work to a detached supervisor dedicated to one job.

The difficult question is when the CLI may safely report that the job was accepted. A child PID is not enough. The child might exit before taking ownership, the ownership transaction might commit while its acknowledgement is lost, or the submitting terminal might disappear during either step.

Jobman treats acceptance as a protocol:

> A submission succeeds only after the CLI observes a durable supervisor claim, either through the normal acknowledgement or by reconciling with the datastore.

The datastore is authoritative. The pipes between the two processes only make the common case fast.

## The handoff

The complete handoff has two durable transitions separated by a process launch:

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

There is deliberately no transaction spanning the process launch. SQLite cannot atomically commit a row and create an operating-system process. Instead, Jobman makes each side independently recoverable and defines which durable state is valid at every boundary.

## Persist before detaching

Before starting the supervisor, Jobman resolves the effective configuration and constructs an immutable job specification. It includes the executable and argument vector, working directory, environment policy, dependency IDs, retry policy, timeouts, logging policy, and other settings the supervisor will need later.

Dependency selectors are resolved to canonical job IDs at this point. A later job with the same display name cannot change what the submitted analysis job depends on.

Jobman then generates:

- a UUIDv7 job ID;
- 32 random bytes for a one-time launch credential;
- a SHA-256 hash of that credential; and
- a bounded claim deadline, currently ten seconds after submission.

Reduced to its essential operations, submission looks like this:

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

The actual implementation checks every error, but the ordering is the point: the job is committed before the supervisor is launched.

That first transaction inserts the job in the `submitting` phase together with its runtime state, immutable dependency edges, and initial `job_submitted` event. A reader can never observe a submitted job without the prerequisites that govern whether it may run.

Only the credential hash is stored. The plaintext credential exists briefly in the submitting process and travels to the supervisor through an inherited stdin pipe. It does not appear in command-line arguments, environment variables, logs, or persistent state.

If the CLI crashes after the transaction but before launching the supervisor, the job remains visibly `submitting`. Once its claim deadline expires, reconciliation can complete it as `submission_failed`. There is a durable explanation rather than a job that silently remains active or is guessed to have started.

## The same binary, in a private mode

The supervisor is another invocation of the Jobman executable using a hidden `__supervise` command. Its command line contains the non-secret job ID, but not the target executable or its policy. Those are loaded from the committed specification.

The launch creates two short-lived pipes:

- stdin carries exactly one launch credential to the supervisor;
- stdout carries one bounded, versioned acknowledgement back to the CLI.

The supervisor's stderr is detached from the submitting terminal. Platform-specific launch settings create the longer-lived process boundary: a new session on Linux and macOS, and detached process-group facilities on Windows.

The Go context boundary is just as important. The supervisor is created with a context derived using `context.WithoutCancel`. Interrupting `jobman run`, closing the terminal, or losing an SSH connection must not cancel a supervisor that has already been accepted.

This private command is a transport, not an alternate API. A caller cannot use it to substitute a different executable, working directory, or log path. The durable record remains the only source of trusted job configuration.

## Claiming ownership atomically

The supervisor reads the 32-byte credential, opens the same datastore, generates its own UUIDv7 ID, and records its operating-system process identity. It then attempts to claim the job.

The claim is valid only if all of the following remain true:

- the job is still in `submitting`;
- its claim deadline has not expired;
- the supplied credential matches the stored hash;
- the expected job revision is current; and
- the supervisor identity and lease are valid.

On success, one SQLite transaction:

1. moves the job from `submitting` to `starting`;
2. increments its revision;
3. records the supervisor ID and claim time;
4. clears the launch credential hash and claim deadline;
5. creates the supervisor record and initial lease; and
6. appends the corresponding job and supervisor events.

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

Clearing the credential makes it single-use. Even if another copy of the supervisor command is started with the original bytes, it cannot claim the job again. A second claimant also loses the revision-and-phase comparison after the first transaction commits.

This is optimistic concurrency rather than a long-held application lock. Each mutable snapshot has a monotonically increasing revision. An update includes its expected revision and phase in the SQL `WHERE` clause; updating zero rows is a conflict, not success. The caller must reload the current state and decide what that state means for the requested operation.

## When the acknowledgement disappears

After the claim commits, the supervisor sends a small JSON acknowledgement containing a schema version, the job ID, and the supervisor ID. The CLI bounds the response size, rejects unknown fields, verifies both identities, and normally prints the job ID immediately.

Now consider a failure in the analysis example: the claim commits, but the supervisor exits or the pipe closes before the acknowledgement reaches `jobman run`.

From the CLI's perspective, the pipe failure is ambiguous. It could mean the supervisor never claimed the job, or it could mean a valid owner is already evaluating the preparation dependency. Treating the pipe failure as a failed submission would invite the caller to submit a duplicate. Killing the child would be worse: the PID might no longer identify the process that committed the claim.

Jobman therefore reloads the job using a fresh, bounded context. This reconciliation is intentionally independent of the submitting command's canceled context. If the datastore contains a valid supervisor ID and the job has advanced beyond `submitting`, the handoff succeeded. The CLI synthesizes the same acknowledgement from durable state and returns the job ID normally.

If no claim is present, Jobman reports the launch failure. An unclaimed job that passes its deadline is later finalized as `submission_failed`; uncertain identity is never converted into a guessed success.

The main crash windows are:

| Failure point                             | Durable state                              | Interpretation                                        |
| ----------------------------------------- | ------------------------------------------ | ----------------------------------------------------- |
| Before the submission transaction commits | No job                                     | Submission failed                                     |
| After commit, before supervisor launch    | `submitting`, unclaimed                    | Reconcile after the claim deadline                    |
| After launch, before claim                | `submitting`, unclaimed                    | Another valid claim may still win before the deadline |
| After claim, before acknowledgement       | `starting`, supervisor recorded            | Submission succeeded                                  |
| After acknowledgement, before ID is shown | Claimed job remains discoverable in Jobman | Submission succeeded, though the shell lost its reply |
| Supervisor disappears after claiming      | Claimed job with an aging lease            | Verify identity, then reconcile conservatively        |

The protocol cannot guarantee that a shell captures the printed ID if the shell itself disappears. It guarantees that an accepted job has a durable canonical ID and owner that later Jobman commands can inspect.

## A state machine, not a status string

The claim protocol is one use of a broader rule in Jobman: lifecycle changes are explicit transitions, not arbitrary assignments to a status column.

The model layer receives validated snapshots and returns a transition result containing updated job, run, or supervisor state; append-only event drafts; and any external effects that should follow the commit. The store validates the result again and writes the new snapshots and events in one transaction.

This separates three questions:

1. **Is the transition legal?** A job can be claimed only from `submitting`, and a run can start only after it has been durably reserved.
2. **Did this caller win the race?** Revision and phase predicates reject stale updates from concurrent processes.
3. **What external work follows?** The supervisor is launched only after submission commits; cancellation intent is committed before a signal is sent.

The current snapshot makes inspection efficient. The event history explains how the snapshot was reached. Jobman is not rebuilt by replaying events, but a visible transition cannot commit without its corresponding event.

This matters because multiple independent processes may act on the same job. A supervisor can renew its lease while another CLI records cancellation. Two clients can request cancellation at nearly the same time. A stale supervisor may try to finalize a run after reconciliation has already marked its ownership lost. Compare-and-swap transitions ensure that only a state change based on the current revision can commit.

Idempotent operations are handled deliberately. Repeating the same accepted cancellation can return the committed result without producing another destructive effect. A conflicting noncommutative operation must reload and reevaluate instead of blindly retrying an old update.

## Leases are evidence, not proof

Once claimed, a supervisor records a 15-second lease and normally renews it every five seconds. The lease makes abandoned ownership detectable without requiring a shared daemon to monitor every job continuously.

An expired lease does not prove that the supervisor is dead. The machine may have been suspended, the process may have paused between renewal and commit, or SQLite may have been temporarily busy. Reconciliation therefore verifies the stored process identity before changing the job.

That identity contains more than a PID. Where the platform provides it, Jobman records process creation identity, boot identity, and a separate target-tree identity. A PID can be reused; signaling or judging a new process based only on the old number would be unsafe.

If Jobman can verify that an expired supervisor no longer owns a live process, it records the job as `lost` rather than inventing a target result. Version 1 does not attempt to adopt a target after its supervisor disappears. That is conservative, but it preserves the more important invariant: supervisor failure cannot be reported as fabricated success.

The platform-specific process-tree mechanics and timeout escalation deserve their own treatment. Here, the lease has a narrower purpose: it leaves durable evidence that ownership should be checked.

## Why this much protocol?

Several simpler designs remove steps but also remove guarantees:

- **Detach only the target.** Nothing remains to evaluate dependencies, drain output pipes, enforce retries, or reap the process.
- **Keep the submitting CLI alive.** Closing its terminal makes job management unreliable and turns `run` into a foreground command.
- **Use a shared daemon.** Ownership becomes simpler, but installation, upgrades, authorization, and unrelated-job failure isolation all change.
- **Trust the child PID.** PID reuse and uncertain start state make later observation or signaling unsafe.

The per-job supervisor costs an additional process and datastore connection for every active or waiting job. In return, it gives each job a bounded owner without introducing a resident service or shared in-memory scheduler.

The launch credential is also intentionally narrow. It prevents stale, accidental, or competing supervisor claims. It is not a security boundary against another process already running as the same operating-system user, which can generally access that user's files and processes.

## What acceptance guarantees

When `jobman run` prints the analysis job ID, Jobman has established that:

- the complete job specification and dependencies are durable;
- exactly one supervisor has committed ownership;
- the one-time credential can no longer be replayed;
- the supervisor's identity and initial lease are recorded;
- loss of the acknowledgement has been reconciled against durable state; and
- later failure will be recorded as failure, loss, or another explicit outcome rather than inferred as success.

It does not mean the analysis process has started. It may still be waiting for preparation to succeed, retry backoff to elapse, or concurrency capacity to become available. Acceptance transfers ownership; scheduling decides when a run is eligible.

That distinction is the subject of [Part 3: Scheduling Without a Central Scheduler](/posts/inside-jobman-part-3/): how independent supervisors coordinate dependencies, waits, retry delays, and fair concurrency limits.

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
