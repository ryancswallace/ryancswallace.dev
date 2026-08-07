---
author: Ryan Wallace
pubDatetime: 2026-07-17T13:42:00Z
modDatetime: 2026-07-17T13:42:00Z
title: "Inside Jobman, Part 1: Reliable Background Jobs Without a Daemon"
slug: inside-jobman-part-1
featured: false
draft: false
tags:
  - jobman
  - go
  - systems-programming
  - cli
description: A technical introduction to Jobman's architecture through a real workflow with dependencies, retries, durable state, and logs.
---

<!-- markdownlint-disable MD014 -->

> **Inside Jobman:** **Part 1: Architecture** ·
> [Part 2: Ownership transfer](/posts/inside-jobman-part-2/) ·
> [Part 3: Scheduling](/posts/inside-jobman-part-3/) ·
> [Part 4: Process control and logs](/posts/inside-jobman-part-4/)

**[Jobman](https://github.com/ryancswallace/jobman)** is a daemonless job manager for local background processes. Jobman was written for work that has outgrown `nohup` and ad hoc shell scripts but does not justify a full-fledged service or distributed scheduler.

Jobman provides:

| Concern            | Jobman's approach                                       |
| ------------------ | ------------------------------------------------------- |
| Detached execution | One short-lived supervisor per job                      |
| Durable state      | Transactional metadata in SQLite                        |
| Output             | Separate stdout and stderr files with an ordering index |
| Reliability        | Retries, backoff, delays, and timeouts                  |
| Coordination       | Inter-job dependencies and concurrency limits           |
| Lifecycle control  | Status, wait, pause, resume, cancel, and rerun          |
| Automation         | Versioned JSON and stable exit codes                    |

In contrast to other job managers, there is no shared Jobman daemon or system service. Completed jobs leave no supervisor or other processes running.

<figure>
  <video controls muted playsinline autoplay loop preload="metadata">
    <source src="/videos/jobman-basic-cli.webm" type="video/webm" />
    <a href="/videos/jobman-basic-cli.gif">View the GIF version</a>
  </video>
  <figcaption>Basic Jobman command line behavior.</figcaption>
</figure>

## A small pipeline

Consider a two-step workflow:

<div class="mermaid">
flowchart LR
    A["Prepare input"] -->|"success"| B["Analyze input"]
    B -->|"exit 1"| C{"Retries left?"}
    C -->|"yes"| B
    C -->|"no"| D["Fail job"]
    B -->|"exit 0"| E["Complete"]
</div>

There are four requirements for this workflow:

- preparation and analysis should run in the background;
- analysis must not start unless preparation succeeds;
- a transient analysis failure should be retried;
- each attempt's output and result should remain inspectable.

Let's see how Jobman can satisfy these requirements.

Submit the preparation step:

```console
$ prepare_id=$(jobman run -- python prepare_data.py)
```

`jobman run` returns the job's canonical ID immediately after a detached supervisor has claimed it. The target then continues independently of the submitting terminal.

Then submit the analysis job with a dependency on preparation:

```console
$ analyze_id=$(jobman run --after-success "$prepare_id" \
    --retries 2 --retryable-exit-code 1 --retry-delay 1s \
    -- python analyze_data.py)
```

The flags in the above command encode three policy decisions for the analysis job:

| Option                          | Meaning                                                 |
| ------------------------------- | ------------------------------------------------------- |
| `--after-success "$prepare_id"` | Start only after preparation job succeeds               |
| `--retryable-exit-code 1`       | Treat exit status 1 as transient                        |
| `--retries 2 --retry-delay 1s`  | Permit two additional attempts, separated by one second |

The policy is stored before the background supervisor begins evaluating it. A later CLI invocation does not have to reconstruct the pipeline from shell history.

## Inspecting jobs and runs

While the jobs run, inspect either one:

```console
$ jobman status "$prepare_id"
019fd6ef-055d-7490-bd56-3ca0641a9ead            running

$ jobman status "$analyze_id"
019fd6ef-3c98-7105-af83-35a8463f174a            waiting
```

Wait for analysis to reach a terminal state:

```console
$ jobman wait "$analyze_id"  # blocks until completion of analyze job
$ echo $?
0
```

`wait` is an observer, not an owner. Interrupting it does not cancel the job.

After it finishes, `show` output includes the complete run history:

```console
$ jobman show "$analyze_id"
ID:                       019fd6ef-3c98-7105-af83-35a8463f174a
Name:
Phase:                    completed
Outcome:                  success
Submitted:                2026-08-06T11:57:10.680058Z
Executable:               python3
Working directory:        /tmp/jobman-demo
Completed runs:           1
Successful runs:          1
Failed runs:              0
Dependencies:             1
Wait evaluations:         0
Admission:                released, global, 1 slot(s)
Notification deliveries:  0
Pending notifications:    0
Notification attempts:    0

RUN  PHASE      OUTCOME  STARTED                      COMPLETED                   LOGS
1    completed  success  2026-08-06T11:57:56.938923Z  2026-08-06T11:58:57.19494Z  available
```

The two output streams retain their identities:

```console
$ jobman logs --stream stderr "$analyze_id"
temporary analysis failure

$ jobman logs --stream stdout "$analyze_id"
result: 42
```

For scripts, Jobman provides versioned JSON:

```console
$ jobman show --json "$analyze_id" | jq
{
  "schema_version": 1,
  "data": {
    "admission": {
      "acquired_at": "2026-08-06T11:57:56.93196Z",
      "job_id": "019fd6ef-3c98-7105-af83-35a8463f174a",
      "lease_expires_at": "2026-08-06T11:59:10.709521723Z",
      "released_at": "2026-08-06T11:58:57.19494Z",
      "run_id": "019fd6ef-f146-7d52-8101-d7596476b586",
      "slots": 1
    },
    "claimed_at": "2026-08-06T11:57:10.706028Z",
    "completed_at": "2026-08-06T11:58:57.19494Z",
    "dependencies": [
      {
        "depends_on": "019fd6ef-055d-7490-bd56-3ca0641a9ead",
        "job_id": "019fd6ef-3c98-7105-af83-35a8463f174a",
        "observed_outcome": "success",
        "observed_revision": 5,
        "predicate": "success",
        "satisfied_at": "2026-08-06T11:57:56.929663Z"
      }
    ],
    "notification_attempts": [],
...
    "summary": {
      "id": "019fd6ef-3c98-7105-af83-35a8463f174a",
      "outcome": "success",
      "phase": "completed",
      "revision": 8,
      "submitted_at": "2026-08-06T11:57:10.680058Z"
    },
    "wait_evaluations": []
  }
}
```

## Who owns the job after submission?

While detaching a process is straightforward, managing it after detachment presents technical challenges.

Once the submitting CLI exits, some component must still:

- evaluate dependencies and retry policy;
- acquire concurrency capacity;
- start and reap the target processes;
- capture stdout and stderr;
- enforce timeout and cancellation policy;
- commit lifecycle transitions;
- deliver configured notifications.

Jobman assigns that responsibility to a per-job supervisor:

<div class="mermaid">
sequenceDiagram
    participant CLI as Submitting CLI
    participant DB as Local datastore
    participant S as Per-job supervisor
    participant T as Target process
    CLI->>DB: Create submitting job
    CLI->>S: Launch with one-time credential
    S->>DB: Atomically claim job
    S-->>CLI: Acknowledge durable claim
    CLI-->>CLI: Print job ID and exit
    S->>T: Start target
    T-->>S: Output and exit status
    S->>DB: Commit run and job results
    S-->>S: Exit
</div>

The supervisor is another invocation of the Jobman executable in a private mode. It owns one job and terminates after the job and its completion work finish.

With one supervisor per job, Jobman does not need:

- a shared long-running failure domain;
- privileged system integration;
- daemon installation and upgrade coordination;
- logic to handle version skew between clients and a long-running service.

However, Jobman still needs to manage coordination: supervisors and CLI commands contend over the same datastore, so lifecycle changes use transactions and revision checks.

## Two data storage systems

Metadata and logs put different demands on storage, so Jobman keeps them separate.

<div class="mermaid">
flowchart TB
    J["Jobman commands and supervisors"] --> DB["SQLite metadata (datastore)"]
    J --> FS["Private log files"]
    DB --> M["Jobs, runs, events, leases, policy"]
    FS --> O["stdout"]
    FS --> E["stderr"]
    FS --> I["Chunk ordering index"]
</div>

SQLite is a good fit for:

- atomic lifecycle transitions;
- concurrent readers and writers;
- schema migration;
- querying job history.

Raw files are a better fit for the potentially large byte streams of logs. Keeping logs out of SQLite also means Jobman does not have to turn arbitrary process output into database rows.

The split also lets Jobman record two distinct facts:

1. what happened to the target process;
2. whether its output was recorded completely.

A logging failure does not rewrite a successful process exit as a failed execution. Jobman reports the target outcome and the integrity of its logs separately.

## Commands run without a shell

Everything after `--` is an executable and its argument vector. Jobman does not implicitly pass the command through a shell.

For a normal executable:

```console
$ jobman run -- tar -xzf report.tar.gz
019fd6f9-3ac1-7ab1-8fc0-534385d52c50
```

Shell evaluation must be explicit:

```console
$ jobman run -- sh -c 'generate | compress > report.tar.gz'
019fd6f9-7695-7531-ac95-668028a91ed3
```

Direct execution preserves argument boundaries, and also keeps shell quoting and command injection out of ordinary Jobman invocations.

## Where Jobman's guarantees end

Jobman is intentionally designed as a single-host (i.e., local) solution.

| Jobman handles                         | Jobman does _not_ handle            |
| -------------------------------------- | ----------------------------------- |
| Per-user jobs on one machine           | Distributed scheduling              |
| Local dependency evaluation            | Placement across hosts              |
| Process-tree lifecycle control         | Cluster resource discovery          |
| Named concurrency pools                | Preemption or fair-share scheduling |
| Durable local logs and state           | Remote log aggregation              |
| Operation over an existing SSH session | A remote-control service            |

A Jobman job:

- _will_ survive the terminal or SSH connection that submitted it;
- _may not_ survive the end of the operating system user session, depending on OS configuration;
- _will not_ survive a system shutdown or reboot.

Jobman does not purport to be a machine-level service manager. This boundary keeps the tool useful without introducing all the complexities of a distributed system.

## Next: ownership transfer

In [Part 2: Transferring Job Ownership to a Detached Supervisor](/posts/inside-jobman-part-2/), we trace the submission protocol from its first SQLite transaction through the detached supervisor claim, including what happens when the acknowledgement is lost.

---

**Next:** [Part 2: Transferring Job Ownership to a Detached Supervisor](/posts/inside-jobman-part-2/)

[View every Jobman article](/tags/jobman/)

<script type="module">
  import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";

  mermaid.initialize({
    startOnLoad: false,
    theme: document.documentElement.dataset.theme === "dark" ? "dark" : "default",
  });

  await mermaid.run({ querySelector: ".mermaid" });
</script>
