import { Log, LogEvent, UniversalLog } from "@aspen.cloud/agent-typings";

interface MemoryEvent extends Log<any> {
  agentId: string;
  resourceId?: string;
  type: string;
}

export default class MemoryLog implements UniversalLog {
  private log: MemoryEvent[] = [];
  private continuations = new Map<string, { lastSeen: number; value: any }>();

  constructor() {}

  async appendToLog({
    agentId,
    type,
    payload,
    tags,
    resourceId,
  }: {
    agentId: string;
    type: string;
    payload: {};
    tags?: Record<string, string> | undefined;
    resourceId?: string | undefined;
  }) {
    this.log.push({
      agentId,
      data: payload,
      tags:
        resourceId == null ? { ...tags } : { ...tags, _resourceId: resourceId },
      resourceId,
      type,
      inserted_at: new Date(),
      id: this.log.length + 1,
    });
  }

  async processLogsSince({
    agentId,
    lastSeen,
    processor,
    tags,
  }: {
    agentId: string;
    lastSeen: number;
    processor: (row: Log<any>) => void;
    tags?: Record<string, string> | undefined;
  }) {
    this.log
      .slice(lastSeen)
      .filter(
        (evt) =>
          evt.agentId === agentId &&
          Object.keys(tags ?? {}).every(
            (tagKey) => evt.tags && tags && evt.tags[tagKey] === tags[tagKey]
          )
      )
      .forEach(processor);
  }

  async getEvents(
    options?:
      | {
          offset?: number | undefined;
          count?: number | undefined;
          agentId?: string | undefined;
        }
      | undefined
  ): Promise<MemoryEvent[]> {
    return this.log;
  }

  private getContinuationKey({
    agentId,
    name,
    tags,
  }: {
    agentId: string;
    name: string;
    tags: Record<string, string>;
  }) {
    return `${agentId}-${JSON.stringify(name)}-${JSON.stringify(tags)}`;
  }

  async getContinuation({
    agentId,
    name,
    tags,
  }: {
    agentId: string;
    name: string;
    tags?: Record<string, string> | undefined;
  }): Promise<{ lastSeen: number; value: any } | null> {
    return (
      this.continuations.get(
        this.getContinuationKey({ agentId, name, tags: tags ?? {} })
      ) ?? null
    );
  }

  async saveContinuation({
    agentId,
    name,
    type,
    lastSeen,
    value,
    tags,
  }: {
    agentId: string;
    name: string;
    type: "trigger" | "aggregation";
    value?: any;
    lastSeen: number;
    tags: Record<string, string> | null;
  }) {
    this.continuations.set(
      this.getContinuationKey({ agentId, name, tags: tags ?? {} }),
      {
        lastSeen,
        value,
      }
    );
  }

  async createResource() {
    return Math.floor(Math.random() * Number.MAX_SAFE_INTEGER).toString();
  }
}
