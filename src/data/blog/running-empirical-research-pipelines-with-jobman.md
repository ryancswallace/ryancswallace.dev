---
author: Ryan Wallace
pubDatetime: 2026-07-25T10:04:00Z
modDatetime: 2026-07-25T10:04:00Z
title: "Running Empirical Research Pipelines with Jobman"
slug: running-empirical-research-pipelines-with-jobman
featured: true
draft: false
tags:
  - jobman
  - pipelines
  - cli
  - research
description: A practical guide to running reliable research pipelines with Jobman using dependencies, retries, timeouts, concurrency limits, durable logs, and notifications.
---

<div
  class="not-prose mx-auto mb-8 flex max-w-xl justify-center rounded-xl bg-[#212737] px-6 py-5"
>
  <img
    class="h-auto w-full max-w-md !border-0"
    src="/images/jobman-logo-dark-transparent.svg"
    alt="Jobman"
  />
</div>

<div class="grid gap-4 sm:grid-cols-[minmax(0,1fr)_16rem] sm:items-start">
  <div>
    <p class="mt-0">
      Empirical research often involves long-running work on a local workstation
      or remote server:
    </p>
    <ul class="mb-0">
      <li>cleaning data;</li>
      <li>fitting models or running simulations;</li>
      <li>producing tables and figures;</li>
      <li>repeating specifications across samples and outcomes.</li>
    </ul>
  </div>
  <aside class="not-prose rounded-lg border border-border bg-muted/40 p-4">
    <p class="mt-0 mb-3 text-sm font-semibold text-foreground">Project links</p>
    <nav aria-label="Jobman links">
      <ul class="m-0 list-none space-y-3 p-0">
        <li>
          <a
            class="block text-sm font-medium break-words text-foreground underline decoration-dashed underline-offset-4 hover:text-accent"
            href="https://github.com/ryancswallace/jobman"
          >
            ryancswallace/jobman
          </a>
          <span class="text-xs text-foreground/70">GitHub repository</span>
        </li>
        <li>
          <a
            class="block text-sm font-medium break-words text-foreground underline decoration-dashed underline-offset-4 hover:text-accent"
            href="https://jobman.tech/"
          >
            Documentation
          </a>
          <span class="text-xs break-words text-foreground/70">jobman.tech</span>
        </li>
      </ul>
    </nav>
  </aside>
</div>

Jobman runs these tasks durably in the background while adding support for inter-task dependencies, retries, timeouts, logs, concurrency limits, and notifications. It combines the benefits of `nohup` and terminal job control with the features of more heavy-weight schedulers.

## A typical research pipeline

Consider a project with four stages:

<div class="mermaid">
flowchart LR
    A["Download data"] --> B["Clean data"]
    B --> C["Estimate models"]
    C --> D["Build tables"]
    C --> E["Build figures"]
</div>

Each stage should start only after its inputs are ready. A failure should stop dependent work rather than produce results from stale files.

Jobman makes running these inter-dependent jobs easy. Submit the first two jobs:

```console
$ fetch=$(jobman run --name fetch -- python fetch.py)
$ clean=$(jobman run --name clean --after-success "$fetch" -- Rscript clean.R)
```

(The `jobman run` command returns immediately and prints the unique job ID of the newly created job to stdout, so the variables `$fetch`, `$clean`, etc. contain job IDs.)

Submit the estimation job:

```console
$ model=$(jobman run --name model --after-success "$clean" -- stata -b do model)
```

Finally, submit the output creation jobs:

```console
$ jobman run --after-success "$model" -- Rscript tables.R
$ jobman run --after-success "$model" -- python figures.py
```

Jobman records the dependency graph when each job is submitted. You can close the terminal while the pipeline runs.

## Check progress

Use `list` for an overview of the **status** of all (active) jobs:

```console
$ jobman list --active
```

Use `status` for one job:

```console
$ jobman status model
```

Use `show` for **job specifications** and the job's **run history**:

```console
$ jobman show model
```

| Subcommand   | Best use                       |
| ------------ | ------------------------------ |
| `list`       | Review several jobs            |
| `status JOB` | Check one current result       |
| `show JOB`   | Inspect policy and run history |
| `wait JOB`   | Block until completion         |
| `logs JOB`   | Read captured output           |

## Keep logs after disconnecting

Jobman captures **stdout and stderr logs** independently.

Show all logs (stdout and stderr) for a job:

```console
$ jobman logs model
```

Follow logs for a running job:

```console
$ jobman logs --follow model
```

Inspect warnings (stderr only):

```console
$ jobman logs --stream stderr model
```

Read only the last 50 lines:

```console
$ jobman logs --lines 50 model
```

Show logs across all runs for a job with several attempts:

```console
$ jobman logs --all model
```

This is particularly useful for software that reports diagnostics like convergence warnings, dropped observations, or failed specifications on stderr.

Raw target output is recorded to disk and is _not_ automatically redacted. Don't print credentials or confidential data to logs.

## Retry transient failures

Downloads, APIs, database connections, and licensed software can fail temporarily. A bounded **retry policy** handles those cases without suppressing permanent errors.

```console
$ jobman run --name download \
    --retries 3 --retryable-exit-code 1 \
    --retry-delay 10s --retry-backoff exponential \
    -- python download.py
```

`--retries 3` permits four attempts in total: the initial run and three retries.

A script can use distinct exit codes to separate transient failures from invalid inputs. Only failures (i.e., exit codes) you classify as retryable trigger another attempt.

This allows you to customize the retry policy based on the type of failure encountered:

| Outcome                   | Suggested treatment  |
| ------------------------- | -------------------- |
| Temporary network failure | Retry                |
| Rate limit                | Retry with backoff   |
| Invalid program state     | Fail immediately     |
| Run timeout               | Retry only when safe |

## Bound execution time

Use a **run timeout** to stop one attempt:

```console
$ jobman run --run-timeout 2h -- python bootstrap.py
```

Use a **job timeout** to bound the entire lifecycle, including waiting and retries:

```console
$ jobman run --job-timeout 8h -- python bootstrap.py
```

Run timeouts and job timeouts can be combined:

```console
$ jobman run --run-timeout 2h --job-timeout 6h \
    --retry-timeouts --retries 2 -- python bootstrap.py
```

| Limit           | Covers                                                |
| --------------- | ----------------------------------------------------- |
| `--run-timeout` | One execution attempt                                 |
| `--job-timeout` | Dependencies, queueing, delays, attempts, and retries |

Timeouts are useful protection against stalled optimizers, infinite loops, inaccessible network resources, and simulations with pathological parameters.

## Limit concurrent work

Parallel jobs can exhaust memory or make every model slower. Jobman supports store-wide capacity and named pools.

For example, configure separate limits for downloads and models:

```yaml
concurrency:
  max_active_slots: 8
  pools:
    downloads: 2
    models: 4
```

Then assign work to a pool:

```console
$ jobman run --pool models -- python model_a.py
$ jobman run --pool models -- python model_b.py
```

A memory-intensive job can request several slots:

```console
$ jobman run --pool models --slots 2 -- stata -b do simulation_a
```

Waiting jobs do not consume slots before their dependencies and wait conditions are satisfied.

Pools are useful for:

- limiting simultaneous database queries;
- preventing runs from exhausting RAM;
- restricting calls to rate-limited services;
- reserving capacity for different workload classes.

## Wait for data to arrive

A job can **wait** for various conditions before starting.

To wait for a file:

```console
$ jobman run --wait-file data/raw/complete.flag -- python clean.py
```

To wait until a specified time:

```console
$ jobman run --wait-until 2026-08-01T02:00:00Z -- python import.py
```

Or begin after a relative delay:

```console
$ jobman run --wait-delay 30m -- python refresh.py
```

Add an abort time when an input becomes useless after a deadline:

```console
$ jobman run --wait-file data/ready \
    --wait-abort-at 2026-08-01T12:00:00Z -- python estimate.py
```

## Organize related jobs

Attach **groups and tags** when submitting work:

```console
$ jobman run --group paper_a --tag baseline -- python model.py
```

Filter the job list by group:

```console
$ jobman list --group paper_a
```

Possible research-oriented groups include:

- `paper`;
- `policy`;
- `replication`;
- `robustness`;
- `simulation`;
- `data-refresh`.

Tags can record characteristics such as `baseline`, `placebo`, `restricted-sample`, or `clustered-se`.

Job names are labels, not unique identifiers. Reusing a name does not overwrite an earlier job.

## Set the working environment explicitly

The `run` subcommand supports multiple options for configuring the execution environment differently from the parent shell.

Set the working directory:

```console
$ jobman run --cwd /work/project -- Rscript analysis.R
```

Set an environment value:

```console
$ jobman run --env SPEC=baseline -- python model.py
```

Remove an inherited value:

```console
$ jobman run --unset-env DEBUG -- python model.py
```

Note that Jobman executes the specified target program directly. It does _not_ interpret shell operators unless you explicitly run a shell:

```console
$ jobman run -- sh -c 'python model.py > summary.txt'
```

Prefer direct execution when shell syntax is unnecessary.

## Repeat a specification

**Rerun** a prior job without reconstructing its options:

```console
$ jobman rerun models --name models-rerun
```

The new job receives a copy of the earlier job's specification and gets its own identity and history.

For repeated sampling or simulations, define explicit completion limits:

```console
$ jobman run --max-runs 100 --success-target 100 -- python simulate_once.py
```

Jobman can also tolerate a bounded number of failed draws:

```console
$ jobman run --max-runs 110 --success-target 100 \
    --failure-limit 11 -- python simulate_once.py
```

This is useful when each execution produces one independent result that can be aggregated later.

## Control active work

Jobman provides several **lifecycle commands**:

Pause and resume are useful when interactive work temporarily needs the machine’s resources:

```console
$ jobman pause models
$ jobman resume models
```

Cancellation applies to the managed process tree, not only the initial process. Jobman first requests a graceful stop and can force termination after the configured grace period.

```console
$ jobman cancel models
```

Waiting on a job blocks until the job completes:

```console
$ jobman wait models
```

## Receive completion notifications

Jobman supports configured command callbacks, HTTPS webhooks, and SMTP notifications.

For example, if a notifier named `research` is configured, this invocation sends a message to that notification channel if the job fails:

```console
$ jobman run --notify research --notify-on job_failed -- python models.py
```

Useful events include:

- job succeeded;
- job failed;
- job timed out;
- retry scheduled;
- run started or completed.

Notifications are especially useful for jobs running outside work hours and for remote sessions.

## Use stable output in scripts

Human-readable output is intended for terminals. Use **machine-readable JSON** for automation:

```console
$ jobman status --json models
$ jobman show --json models
$ jobman list --json --group paper
```

This makes it easier to generate run manifests or record job outcomes alongside research artifacts.

For reproducibility, retain:

- the canonical job ID;
- the source revision;
- the input-data version;
- the software environment;
- the command or named job specification;
- relevant Jobman JSON output.

Jobman records execution history, but it does not replace source control, data versioning, or environment management.

## Keep state manageable

Preview history **cleanup** before deleting anything:

```console
$ jobman clean --older-than 30d
```

Apply the cleanup:

```console
$ jobman clean --older-than 30d --force
```

Check the local store:

```console
$ jobman doctor
```

Create a metadata backup before an upgrade or major cleanup:

```console
$ jobman doctor --backup jobman-backup.db
```

Do not delete files inside the Jobman state directory by hand. Jobman avoids removing active state or metadata still required by another job.

## Where Jobman fits

Jobman is designed for single-user work on one machine.

| Good fit                           | Use another system                        |
| ---------------------------------- | ----------------------------------------- |
| Workstation, server, cloud compute | Multi-node computation                    |
| Jobs submitted over SSH            | Cluster-wide scheduling                   |
| Local data pipelines               | Distributed data processing               |
| Parallel robustness checks         | Resource placement across hosts           |
| Overnight models and simulations   | Work requiring a permanent system service |

Note that Jobman jobs:

- _will_ survive a closed terminal or SSH connection;
- _may_ end when the operating system user session ends, depending on host configuration;
- will _not_ survive host shutdown or reboot.

For many research workflows, this is the useful middle ground: more reliable and feature-rich than unmanaged background processes, but substantially simpler than a heavy-weight scheduler.

## Basic use demo

<figure>
  <video controls muted playsinline autoplay loop preload="metadata">
    <source src="/videos/jobman-basic-cli.webm" type="video/webm" />
    <a href="/videos/jobman-basic-cli.gif">View the GIF version</a>
  </video>
  <figcaption>Basic Jobman command line behavior.</figcaption>
</figure>

<script type="module">
  import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";

  mermaid.initialize({
    startOnLoad: false,
    theme: document.documentElement.dataset.theme === "dark" ? "dark" : "default",
  });

  await mermaid.run({ querySelector: ".mermaid" });
</script>
