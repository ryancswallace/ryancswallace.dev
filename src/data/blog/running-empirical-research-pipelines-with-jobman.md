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

# Running Empirical Research Pipelines with Jobman

Empirical research often involves long-running work on a local workstation or remote server:

- cleaning administrative or survey data;
- fitting models in any language (R, Python, Stata, Julia);
- running bootstrap or simulation jobs;
- producing tables and figures;
- repeating specifications across samples and outcomes.

Jobman runs these tasks in the background while adding dependencies, retries, timeouts, logs, concurrency limits, and notifications. It is useful when a shell script feels fragile but a cluster scheduler would be excessive.

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

Submit the first two jobs:

```console
$ fetch=$(jobman run --name fetch -- python fetch.py)
$ clean=$(jobman run --name clean --after-success "$fetch" -- Rscript clean.R)
```

Submit the estimation job:

```console
$ models=$(jobman run --name models \
    --after-success "$clean" -- python models.py)
```

Finally, submit the outputs:

```console
$ jobman run --name tables --after-success "$models" -- Rscript tables.R
$ jobman run --name figures --after-success "$models" -- python figures.py
```

Jobman records the dependency graph when each job is submitted. You can close the terminal while the pipeline runs.

## Check progress

Use `list` for an overview:

```console
$ jobman list --active
```

Use `status` for one job:

```console
$ jobman status models
```

Use `show` for its specification and run history:

```console
$ jobman show models
```

Names are convenient for interactive use. In scripts, retain the full ID returned by `jobman run`.

| Command      | Best use                       |
| ------------ | ------------------------------ |
| `list`       | Review several jobs            |
| `status JOB` | Check one current result       |
| `show JOB`   | Inspect policy and run history |
| `wait JOB`   | Block until completion         |
| `logs JOB`   | Read captured output           |

## Keep logs after disconnecting

Jobman captures stdout and stderr independently.

Follow a running estimation:

```console
$ jobman logs --follow models
```

Inspect warnings:

```console
$ jobman logs --stream stderr models
```

Read only the last 50 lines:

```console
$ jobman logs --lines 50 models
```

For a job with several attempts:

```console
$ jobman logs --all models
```

This is particularly useful for software that reports convergence warnings, dropped observations, or failed specifications on stderr.

Raw target output is not automatically redacted. Do not print credentials or confidential data into logs.

## Retry transient failures

Downloads, APIs, database connections, and licensed software can fail temporarily. A bounded retry policy handles those cases without hiding permanent errors.

```console
$ jobman run --name download \
    --retries 3 --retryable-exit-code 1 \
    --retry-delay 10s --retry-backoff exponential \
    -- python download.py
```

`--retries 3` permits four attempts in total: the initial run and three retries.

Only failures you classify as retryable trigger another attempt. This distinction matters:

| Outcome                     | Suggested treatment  |
| --------------------------- | -------------------- |
| Temporary network failure   | Retry                |
| Rate limit                  | Retry with backoff   |
| Invalid model specification | Fail immediately     |
| Missing required variable   | Fail immediately     |
| Run timeout                 | Retry only when safe |

A script can use distinct exit codes to separate transient failures from invalid inputs.

## Bound execution time

Use a run timeout to stop one attempt:

```console
$ jobman run --run-timeout 2h -- python bootstrap.py
```

Use a job timeout to bound the entire lifecycle, including waiting and retries:

```console
$ jobman run --job-timeout 8h -- python bootstrap.py
```

They can be combined:

```console
$ jobman run --run-timeout 2h --job-timeout 6h \
    --retry-timeouts --retries 2 -- python bootstrap.py
```

| Limit           | Covers                                                |
| --------------- | ----------------------------------------------------- |
| `--run-timeout` | One execution attempt                                 |
| `--job-timeout` | Dependencies, queueing, delays, attempts, and retries |

Timeouts are useful protection against stalled optimizers, dead network mounts, and simulations with pathological parameter draws.

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
$ jobman run --pool models --slots 2 -- Rscript bayesian_model.R
```

Waiting jobs do not consume slots before their dependencies and wait conditions are satisfied.

Pools are useful for:

- limiting simultaneous database queries;
- preventing model runs from exhausting RAM;
- restricting calls to rate-limited services;
- reserving capacity for different workload classes.

## Wait for data to arrive

A job can wait for a file:

```console
$ jobman run --wait-file data/raw/complete.flag -- python clean.py
```

It can also wait until a specified time:

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

A file wait observes whether the path exists. The target should still validate the file before using it.

## Organize related jobs

Attach groups and tags when submitting work:

```console
$ jobman run --group paper --tag baseline -- python model.py
```

Filter the job list by group:

```console
$ jobman list --group paper
```

Possible research-oriented groups include:

- `paper`;
- `replication`;
- `robustness`;
- `simulation`;
- `data-refresh`.

Tags can record characteristics such as `baseline`, `placebo`, `restricted-sample`, or `clustered-se`.

Job names are labels, not unique identifiers. Reusing a name does not overwrite an earlier job.

## Set the working environment explicitly

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

Jobman executes the target directly. It does not interpret shell operators unless you explicitly run a shell:

```console
$ jobman run -- sh -c 'python model.py > summary.txt'
```

Prefer direct execution when shell syntax is unnecessary.

## Repeat a specification

Rerun a prior job without reconstructing its options:

```console
$ jobman rerun models --name models-rerun
```

The new job receives a copy of the earlier effective specification and gets its own identity and history.

For repeated sampling or simulations, define explicit completion limits:

```console
$ jobman run --max-runs 100 --success-target 100 \
    -- python simulate_once.py
```

You can also tolerate a bounded number of failed draws:

```console
$ jobman run --max-runs 110 --success-target 100 \
    --failure-limit 11 -- python simulate_once.py
```

This is useful when each execution produces one independent result that can be aggregated later.

## Control active work

Jobman provides several lifecycle commands:

```console
$ jobman pause models
$ jobman resume models
$ jobman cancel models
$ jobman wait models
```

Pause and resume are useful when interactive work temporarily needs the machine’s resources. Platform support differs, so check `jobman doctor` on the host where jobs will run.

Cancellation applies to the managed process tree, not only the initial process. Jobman first requests a graceful stop and can force termination after the configured grace period.

## Receive completion notifications

Jobman supports configured command callbacks, HTTPS webhooks, and SMTP notifications.

Once a notifier named `research` is configured:

```console
$ jobman run --notify research \
    --notify-on job_failed -- python models.py
```

Useful events include:

- job succeeded;
- job failed;
- job timed out;
- retry scheduled;
- run started or completed.

Notifications are especially useful for overnight estimates and remote sessions. Store credentials as configured secret references rather than literal command-line values.

## Use stable output in scripts

Human-readable output is intended for terminals. Use JSON for automation:

```console
$ jobman status --json models
$ jobman show --json models
$ jobman list --json --group paper
```

This makes it easier to build project dashboards, generate run manifests, or record job outcomes alongside research artifacts.

For reproducibility, retain:

- the canonical job ID;
- the source revision;
- the input-data version;
- the software environment;
- the command or named job specification;
- relevant Jobman JSON output.

Jobman records execution history, but it does not replace source control, data versioning, or environment management.

## Keep state manageable

Preview cleanup before deleting anything:

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

Jobman is designed for local, per-user work on one machine.

| Good fit                         | Use another system                        |
| -------------------------------- | ----------------------------------------- |
| Workstation or research server   | Multi-node computation                    |
| Jobs submitted over SSH          | Cluster-wide scheduling                   |
| Local data pipelines             | Distributed data processing               |
| Parallel robustness checks       | Resource placement across hosts           |
| Overnight models and simulations | Work requiring a permanent system service |

Jobs can survive a closed terminal or SSH connection. They may end when the operating-system user session ends, depending on the host configuration.

For many empirical workflows, that is the useful middle ground: more reliable than unmanaged background processes, but substantially simpler than operating a scheduler.

<script type="module">
  import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";

  mermaid.initialize({
    startOnLoad: false,
    theme: document.documentElement.dataset.theme === "dark" ? "dark" : "default",
  });

  await mermaid.run({ querySelector: ".mermaid" });
</script>
