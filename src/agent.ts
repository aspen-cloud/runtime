import { Isolate, Context, Reference } from "isolated-vm";
import {
  ActionAspenContext,
  AggregationParams,
  JobManager,
  SchedulerOptions,
  Trigger,
  UniversalLog,
} from "@aspen.cloud/agent-typings";

//@ts-ignore
const fetch = (...args) =>
  //@ts-ignore
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

async function initVM(codeBundle: string) {
  const isolate = new Isolate({
    onCatastrophicError: (msg) => {
      // TODO support specialized handling
      throw new Error(`Catastrophic V8 Error: ${msg}`);
    },
  });
  const agentScript = await isolate.compileScript(codeBundle);
  const context = await isolate.createContext();
  await agentScript.run(context);
  return {
    isolate,
    agentScript,
    context,
  };
}

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
  const vm = await initVM(code);
  return [
    new Agent({
      id,
      context: vm.context,
      unilog,
      allowedDomains,
      jobManager,
    }),
    () => vm.isolate.dispose(),
  ] as [Agent, () => void];
}

export class Agent {
  //   private readonly unilog: UniversalLog;
  private readonly agentRef: Reference;
  readonly name: string;
  readonly description: string;
  readonly viewKeys: Set<string>;
  readonly actionKeys: Set<string>;
  readonly automationTriggers: Map<string, Trigger>;
  readonly aspenGateway: ActionAspenContext;
  readonly allowedDomains: Set<string>;
  readonly unilog: UniversalLog;
  private context: Context;
  readonly agentId: string;
  private jobManager: JobManager;

  constructor({
    context,
    id,
    unilog,
    jobManager,
    allowedDomains,
  }: {
    context: Context;
    id: string;
    unilog: UniversalLog;
    jobManager: JobManager;
    allowedDomains?: string[];
  }) {
    this.unilog = unilog;
    this.context = context;
    this.agentId = id;
    this.jobManager = jobManager;

    this.agentRef = this.context.global.getSync("agent").getSync("default", {
      reference: true,
      accessors: true,
    });

    this.name = this.agentRef.getSync("name", { copy: true, accessors: true });
    this.description = this.agentRef.getSync("description", {
      copy: true,
      accessors: true,
    });
    const viewKeyList = this.context.evalSync(
      "agent.default.views ? Object.keys(agent.default.views): [];",
      { copy: true }
    );
    this.viewKeys = new Set(viewKeyList);

    const actionKeyList = this.context.evalSync(
      "agent.default.actions ? Object.keys(agent.default.actions): [];",
      { copy: true }
    );
    this.actionKeys = new Set(actionKeyList);

    const automationTriggerList = this.context.evalSync(
      "agent.default.automations ? Object.entries(agent.default.automations).map(([key, value]) => [key, value.runOn]): [];",
      { copy: true }
    );
    this.automationTriggers = new Map(automationTriggerList);

    this.allowedDomains = new Set(allowedDomains ?? []);

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

        const resp = await fetch(input, init);

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
        return this.jobManager.addJob({ actionKey, params, runAt, options });
      },
      unscheduleAction: async (jobKey: string) => {
        this.jobManager.removeJob(jobKey);
      },
      createResource: async () => this.unilog.createResource(),
    };
  }

  async getView(viewName: string, params?: Record<string, string>) {
    if (!this.viewKeys.has(viewName))
      throw new Error("Unrecognized view name.");

    const viewRef = this.agentRef
      .getSync("views", { reference: true })
      .getSync(viewName, { reference: true });

    await this.context.global.set("getViewRef", this.aspenGateway.getView, {
      reference: true,
    });

    await this.context.global.set("aspen", {}, { copy: true });

    this.context.global.setSync(
      "getAggregationRef",
      async (name: string, params: AggregationParams) => {
        const aggregations = await this.agentRef.get("aggregations", {
          reference: true,
        });
        const aggregator = await aggregations.get(name, { reference: true });
        if (aggregator.typeof != "object") {
          throw new Error(
            `Expected aggregator "${name}" to be an object but found ${aggregator.typeof}`
          );
        }
        const reducerRef = await aggregator.get("reducer", { reference: true });
        const initializeRef = await aggregator.get("initialize", {
          reference: true,
        });
        const serializeRef = await aggregator.get("serialize", {
          reference: true,
        });
        const lastProcessed = await this.unilog.getContinuation({
          agentId: this.agentId,
          name,
          tags: params.tags,
        });

        const { lastSeen, value: lastValue } = lastProcessed ?? {
          lastSeen: 0,
          value: null,
        };

        let accumulator = await initializeRef.apply(this.context, [lastValue], {
          arguments: { copy: true },
          result: { reference: true },
        });

        let latestSeen = lastSeen;

        await this.unilog.processLogsSince({
          agentId: this.agentId,
          lastSeen,
          processor: (event) => {
            latestSeen = event.id;
            try {
              accumulator = reducerRef.applySync(
                this.context,
                [accumulator.derefInto(), event],
                {
                  arguments: { copy: true },
                  result: { reference: true },
                }
              );
            } catch (e) {
              throw new Error(`Error in reducer: ${e}`);
            }
          },
          tags: params.tags ?? {},
        });

        const result = await serializeRef.apply(
          this.context,
          [accumulator.derefInto()],
          { arguments: { copy: true }, result: { copy: true } }
        );

        this.unilog.saveContinuation({
          agentId: this.agentId,
          lastSeen: latestSeen,
          name,
          type: "aggregation",
          tags: params.tags ?? null,
          value: result,
        });

        return result;
      },
      { reference: true }
    );

    const setupCode = `
          aspen.getAggregation = async (name, params) => await getAggregationRef.apply(undefined, [name, params], {arguments: {copy: true}, result: { promise: true, copy: true }});
      `;

    await this.context.eval(setupCode);

    const aspenRef = this.context.global.getSync("aspen");
    try {
      const results = await viewRef.applySync(
        null,
        [params, aspenRef.derefInto()],
        {
          arguments: { copy: true },
          result: { promise: true, copy: true },
        }
      );
      return results;
    } catch (e) {
      throw new Error(`Error in view: ${e}`);
    }
  }

  async runAction(actionName: string, params: any): Promise<any> {
    if (!this.actionKeys.has(actionName))
      throw new Error("Unrecognized action.");

    await setupActionExectionEnvironment(this.context, this.aspenGateway);

    const actionRef = await (
      await this.agentRef.get("actions", { reference: true })
    ).get(actionName, { reference: true });

    const aspenRef = this.context.global.getSync("aspen");
    const result = await actionRef.apply(
      undefined,
      [params, aspenRef.derefInto()],
      {
        arguments: { copy: true },
        result: { copy: true, promise: true },
      }
    );

    return result;
  }

  async getConfig() {}

  async setConfig(key: string, value: any) {}

  async runAutomation(automationName: string, params: any) {
    if (!this.automationTriggers.has(automationName))
      //throw new ExternalError("Unrecognized automation.");
      throw new Error("Unrecognized automation");

    await setupActionExectionEnvironment(this.context, this.aspenGateway);

    const actionRef = await this.agentRef
      .getSync("automations", { reference: true })
      .getSync(automationName, { reference: true })
      .get("action", { reference: true });

    const aspenRef = this.context.global.getSync("aspen");
    await actionRef.apply(undefined, [params, aspenRef.derefInto()], {
      arguments: { copy: true },
      result: { copy: true, promise: true },
    });
  }
}

async function setupActionExectionEnvironment(
  context: Context,
  gateway: ActionAspenContext
) {
  await context.global.set("getViewRef", gateway.getView, {
    reference: true,
  });

  await context.global.set("pushEventRef", gateway.pushEvent, {
    reference: true,
  });

  await context.global.set("fetchRef", gateway.fetch, {
    reference: true,
  });

  await context.global.set("scheduleActionRef", gateway.scheduleAction, {
    reference: true,
  });

  await context.global.set("unscheduleActionRef", gateway.unscheduleAction, {
    reference: true,
  });

  await context.global.set("createResourceRef", gateway.createResource, {
    reference: true,
  });

  context.global.set("aspen", {}, { copy: true });

  const setupCode = `
  aspen.fetch = async (input, init, resultParse) => await fetchRef.apply(undefined, [input, init, resultParse], { arguments: { copy: true }, result: { promise: true, copy: true } });
  aspen.getView = async (viewName, tags) => await getViewRef.apply(undefined, [viewName, tags], { arguments: { copy: true }, result: { promise: true, copy: true } });
  aspen.pushEvent = async (type, payload, tags) => await pushEventRef.apply(undefined, [type, payload, tags], { arguments: { copy: true }, result: { promise: true, copy: true } });
  aspen.scheduleAction = async (actionKey, params, runAt, options) => await scheduleActionRef.apply(undefined, [actionKey, params, runAt, options], { arguments: { copy: true }, result: { promise: true, copy: true } });
  aspen.unscheduleAction = async (jobKey) => await unscheduleActionRef.apply(undefined, [jobKey], { arguments: { copy: true }, result: { promise: true, copy: true } });
  aspen.createResource = async () => createResourceRef.apply(undefined, [], { result: { copy: true, promise: true } });
`;

  await context.eval(setupCode);
}
