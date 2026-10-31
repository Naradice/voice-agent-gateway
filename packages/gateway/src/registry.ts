import type { AgentAdapter } from "./adapter.ts";

export class AdapterRegistry {
  private adapters = new Map<string, AgentAdapter>();

  register(adapter: AgentAdapter): void {
    if (this.adapters.has(adapter.agentType)) throw new Error(`adapter already registered: ${adapter.agentType}`);
    this.adapters.set(adapter.agentType, adapter);
  }

  get(agentType: string): AgentAdapter | undefined {
    return this.adapters.get(agentType);
  }

  list(): AgentAdapter[] {
    return [...this.adapters.values()];
  }
}
