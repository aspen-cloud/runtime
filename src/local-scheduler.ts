import { JobManager, SchedulerOptions } from "@aspen.cloud/agent-typings";
import parser from "cron-parser";
import { nanoid } from "nanoid";

interface Job {
  task_identifier: "run-action" | "cron";
  payload: any;
  run_at: Date;
  attempts: number;
  max_attempts: number;
  key: string;
}

interface AddJobParams {
  task_identifier: "run-action" | "cron";
  payload: any;
  run_at: Date;
  max_attempts?: number;
  key?: string;
}

export interface TaskRunner {
  addJob: (params: AddJobParams) => Promise<string>;
  removeJob: (jobKey: string) => Promise<void>;
}

export class LocalTaskRunner implements TaskRunner {
  constructor(
    actionRunner: (payload: any) => Promise<void>,
    cronRunner: (payload: any) => Promise<void>,
    pollInterval: number = 5000
  ) {
    this._actionRunner = actionRunner;
    this._cronRunner = cronRunner;
    this._pollInterval = pollInterval;
  }

  private _actionRunner: (payload: any) => Promise<void>;
  private _cronRunner: (payload: any) => Promise<void>;
  private _pollInterval: number;
  private _jobs: Job[] = [];
  private _isRunning: boolean = false;

  public readonly isRunning = this._isRunning;

  start() {
    if (!this.isRunning) {
      setInterval(() => {
        this._runJobs();
      }, this._pollInterval);
      this._isRunning = true;
    }
  }

  private async _runJobs() {
    const runDate = new Date();
    const jobsToRun = this._jobs.filter((x) => x.run_at < runDate);
    this._jobs = this._jobs.filter((x) => !(x.run_at < runDate));
    for (const job of jobsToRun) {
      if (job.attempts < job.max_attempts) {
        switch (job.task_identifier) {
          case "cron":
            await this.runJob(job, this._cronRunner);
            this._rescheduleCron(job);
            break;
          case "run-action":
            await this.runJob(job, this._actionRunner);
            break;
          default:
            break;
        }
      }
    }
  }

  // ensure failed scheduling isnt weird with cron
  private _rescheduleCron(job: Job) {
    const { userId, agentId, actionKey, schedule, schedulerOptions, params } =
      job.payload;
    const interval = parser.parseExpression(schedule);
    const nextRun = interval.next();
    const jobKey = [nextRun.getTime(), userId, agentId, actionKey].join("_");
    this.addJob({
      task_identifier: "cron",
      payload: { userId, agentId, actionKey, schedule },
      run_at: nextRun.toDate(),
      key: jobKey,
      max_attempts: schedulerOptions.max_attempts,
    });
  }

  private async runJob(job: Job, taskRunner: (payload: any) => Promise<void>) {
    try {
      await taskRunner(job.payload);
      return true;
    } catch (e) {
      console.error(e);
      job.attempts += 1;
      const nextRun = new Date(job.run_at);
      nextRun.setMinutes(nextRun.getMinutes() + 15);
      job.run_at = nextRun;
      this.addJob(job);
      return false;
    }
  }

  async addJob(params: AddJobParams) {
    const key = params.key ?? nanoid();
    const job = {
      task_identifier: params.task_identifier,
      payload: params.payload,
      run_at: params.run_at,
      key,
      max_attempts: params.max_attempts ?? 5,
      attempts: 0,
    };
    this._jobs.push(job);
    return key;
  }

  async removeJob(jobKey: string) {
    this._jobs = this._jobs.filter((j) => j.key !== jobKey);
  }
}

export class LocalJobManager implements JobManager {
  constructor(private taskRunner: TaskRunner, userId: string) {
    this._userId = userId;
  }

  private _userId: string;

  async addJob(
    agentId: string,
    {
      actionKey,
      params,
      runAt,
      options,
    }: {
      actionKey: string;
      params: any;
      runAt: Date;
      options?: SchedulerOptions | undefined;
    }
  ) {
    const key = this.taskRunner.addJob({
      task_identifier: "run-action",
      key: options?.jobKey,
      payload: {
        userId: this._userId,
        agentId: agentId,
        actionKey,
        params,
      },
      run_at: runAt,
      max_attempts: options?.maxAttempts,
    });

    return key;
  }

  async removeJob(jobKey: string) {
    this.taskRunner.removeJob(jobKey);
  }
}
