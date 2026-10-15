# Agent watchdog

A background agent can stop without any notice reaching you. A subagent that ends its turn to wait on its own background child never wakes, because the child's notice goes to the top-level session. A Claude Code restart kills every subagent in flight and reports nothing. Waiting for a notice in either case waits forever. The watchdog checks each agent in flight on a timer that runs outside the Claude Code process.

Arm it for every run that leaves agents running in the background while nobody watches: an orchestrate program, a figure-it-out run, an autonomous run. [liveness.mjs](../scripts/liveness.mjs) keeps the run's state in one run directory, such as the orchestrate store or the folder that holds the decision trail.

## Arm it

1. Inside T3 Code, where `schedule_task` is available, print the task's arguments and pass the fields to `schedule_task` unchanged. Record the returned `scheduledTaskId` in the decision trail.

   ```sh
   node /path/to/poteto-mode/scripts/liveness.mjs schedule <run-dir> --title "<run> watchdog"
   ```

   The task posts a tick into this thread every 20 minutes (`--every <minutes>` changes it) and keeps firing across a Claude Code restart.
2. Outside T3 Code, arm a heartbeat at the same interval with the `loop` skill, using the printed `prompt`. It runs inside Claude Code, so it catches a subagent that waits on its own child but dies in a restart.

## Keep the registry

- When you launch a background agent, run `liveness.mjs start <run-dir> <agent id> <label> <worktree>` with the `agentId` the `Agent` tool returned. Pass `-` as the worktree for an agent that writes nowhere.
- After you audit an agent's result, run `liveness.mjs done <run-dir> <agent id>`.
- T3 Code subagents stay out of the registry. T3 Code wakes the thread when each one finishes, and `task_status` reports on one mid-run.

## Read a tick

The tick runs `liveness.mjs check <run-dir>` and acts on each line.

| line | meaning | you do |
| --- | --- | --- |
| `OK` | the transcript changed in the last 15 minutes, or a process other than a shell runs in the agent's worktree | Nothing. |
| `ENDED` | the last entry is a final message, unchanged for 3 minutes. The agent finished, or it waits on something that will not wake it | Read the final message, then audit the work or take over the steps it left. Run `done`. |
| `STALLED` | no transcript write for 15 minutes and nothing running in the worktree | Read the end of the transcript, then resume the agent with `SendMessage`. Say what stopped it and what is on disk. |
| `PENDING` | a queued `delegate_task` call | Launch it as [Launch T3 Code tasks from a tick](#launch-t3-code-tasks-from-a-tick) says. |

A verdict is a reason to look, not proof. Without `lsof`, as on Windows, the checker cannot see processes, so a long build reads `STALLED`. Read the transcript before you resume anything. Under the orchestrate playbook, `ENDED` and `STALLED` agents are silent deaths, handled by its Liveness and failure rules.

## After a restart

A notice that a background task "didn't finish before the previous session ended" means Claude Code restarted. Every agent in the registry stopped with it, whatever `check` reports for the next 15 minutes. Read the end of each transcript now, then audit or resume each agent.

## Launch T3 Code tasks from a tick

`delegate_task` refuses with `parent_not_active` in a turn that a Claude Code background-task notice woke. A user turn, a T3 Code child's completion and a scheduled task's run can all launch. When a launch is refused, queue it:

1. Write the [t3-task.mjs](../scripts/t3-task.mjs) output to `<run-dir>/wake/<name>.json`.
2. Call `run_scheduled_task_now` with the watchdog's `scheduledTaskId`.

The tick lists each file as `PENDING`, launches it, and deletes the file once T3 Code accepts the task. The file's `clientRequestId` makes a repeated launch the same request.

## Disarm it

When the run ends, delete the task with `delete_scheduled_task`, or stop the loop, and confirm with `list_scheduled_tasks` that it is gone. A watchdog left armed keeps waking the thread.
