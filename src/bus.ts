export type BusMessageKind = "propose" | "feedback" | "resolved" | "escalated" | "note";

export interface BusMessage {
  ts: string;
  /** Sender label — a resolver/agent name, or "gate"/"negotiator". */
  from: string;
  kind: BusMessageKind;
  text: string;
  /** Optional structured payload (e.g. a proposed diff). */
  data?: unknown;
}

/**
 * In-process message bus for sibling negotiation. Deliberately tiny — it reuses
 * peerd's *message vocabulary* (propose / feedback / note) without any of its
 * daemon, TLS, pairing, or human-gating, which don't fit autonomous siblings
 * under one orchestrator. A cross-process substrate (named pipe / file inbox)
 * can implement the same post/subscribe shape later.
 */
export class IntraFleetBus {
  private readonly messages: BusMessage[] = [];
  private readonly subscribers = new Set<(m: BusMessage) => void>();

  post(msg: Omit<BusMessage, "ts">): void {
    const full: BusMessage = { ...msg, ts: new Date().toISOString() };
    this.messages.push(full);
    for (const fn of this.subscribers) fn(full);
  }

  subscribe(fn: (m: BusMessage) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  transcript(): BusMessage[] {
    return [...this.messages];
  }
}
