import {
  ActionAspenContext,
  AggregationParams,
  JobManager,
  SchedulerOptions,
  Trigger,
  UniversalLog,
  Agent as UserAgent,
  ViewAspenContext,
} from "@aspen.cloud/agent-typings";

export async function initializeAgent({
  id,
  code,
  unilog,
  jobManager,
  allowedDomains,
}: {
  id: string;
  code: string;
  unilog: UniversalLog;
  jobManager: JobManager;
  allowedDomains?: string[];
}) {
  return [
    new Agent({
      id,
      userAgent: eval(code) as UserAgent,
      unilog,
      allowedDomains,
      jobManager,
    }),
    () => {},
  ] as [Agent, () => void];
}

export class Agent {
  readonly aspenGateway: ActionAspenContext;
  readonly allowedDomains: Set<string>;
  readonly unilog: UniversalLog;
  private userAgent: UserAgent;
  readonly agentId: string;
  private jobManager: JobManager;

  readonly actions: string[];
  readonly views: string[];

  constructor({
    userAgent,
    id,
    unilog,
    jobManager,
    allowedDomains,
  }: {
    userAgent: UserAgent;
    id: string;
    unilog: UniversalLog;
    jobManager: JobManager;
    allowedDomains?: string[];
  }) {
    this.unilog = unilog;
    this.userAgent = userAgent;
    this.agentId = id;
    this.jobManager = jobManager;

    this.allowedDomains = new Set(allowedDomains ?? []);

    this.actions = Object.keys(this.userAgent.actions ?? {});
    this.views = Object.keys(this.userAgent.views ?? {});

    this.aspenGateway = {
      getView: async (viewName: string, tags?: Record<string, string>) => {
        // TODO support views from other agents
        return this.getView(viewName, tags);
      },
      pushEvent: async (
        type: string,
        data: any,
        metadata?: {
          resourceId?: string;
          tags?: Record<string, string>;
        }
      ) => {
        const { tags, resourceId } = metadata ?? {};
        await this.unilog.appendToLog({
          agentId: this.agentId,
          type,
          payload: data,
          tags: Object.assign(
            {},
            tags,
            { _type: type },
            resourceId ? { _resourceId: resourceId } : {}
          ),
          resourceId: resourceId,
        });
      },
      fetch: async (input, init, resultParse) => {
        const url = new URL(input.toString());
        if (!this.allowedDomains.has(url.host))
          throw new Error(
            `Illegal fetch: Domain ${url.host} not on allowed list`
          );

        const resp = await fetch(url.toString());

        switch (resultParse) {
          case "json":
            return await resp.json();
          case "text":
            return await resp.text();
          default:
            return undefined;
        }
      },
      scheduleAction: async (
        actionKey: string,
        params: any,
        runAt: Date,
        options?: SchedulerOptions
      ) => {
        return this.jobManager.addJob(this.agentId, {
          actionKey,
          params,
          runAt,
          options,
        });
      },
      unscheduleAction: async (jobKey: string) => {
        this.jobManager.removeJob(jobKey);
      },
      createResource: async () => this.unilog.createResource(),
      notify: async (message: string) => {
        this.unilog.createNotification(this.agentId, message);
      },
    };
  }

  async getView(viewName: string, params?: Record<string, string>) {
    if (!this.userAgent.views || !this.userAgent.views[viewName])
      throw new Error("No such view");

    try {
      const results = this.userAgent.views[viewName](
        params,
        // @ts-ignore
        {
          getAggregation: (...args) => this.processAggregation(...args),
        } as ViewAspenContext
      );
      return results;
    } catch (e) {
      throw new Error(`Error in view: ${e}`);
    }
  }

  async runAction(actionName: string, params: any): Promise<any> {
    if (!this.userAgent.actions || !this.userAgent.actions[actionName])
      throw new Error(`Unrecognized action: ${actionName}`);

    const result = this.userAgent.actions[actionName](
      params,
      this.aspenGateway
    );

    return result;
  }

  async processAggregation(aggregationName: string, params: AggregationParams) {
    const { initialize, serialize, reducer } =
      this.userAgent.aggregations[aggregationName];
    const continuation = await this.unilog.getContinuation({
      agentId: this.agentId,
      name: aggregationName,
      tags: params.tags,
    });
    const { lastSeen, value } = continuation ?? { lastSeen: 0, value: null };

    let accumulator = initialize(value);
    let lastProcessed = lastSeen;

    await this.unilog.processLogsSince({
      agentId: this.agentId,
      lastSeen,
      processor: (event) => {
        accumulator = reducer(accumulator, event);
        lastProcessed = event.id;
      },
      tags: params.tags,
    });

    const serializedVal = serialize(accumulator);

    this.unilog.saveContinuation({
      agentId: this.agentId,
      lastSeen: lastProcessed,
      value: serializedVal,
      tags: params.tags ?? null,
      name: aggregationName,
      type: "aggregation",
    });

    return serializedVal;
  }

  async getConfig() {}

  async setConfig(key: string, value: any) {}

  async runAutomation(automationName: string, params: any) {}
}
