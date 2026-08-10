interface GraphNavigationEntry<T> {
  prefix: string;
  state?: T;
}

export interface GraphNavigationSnapshot<T = never> {
  entries: Array<GraphNavigationEntry<T>>;
  index: number;
}

export class GraphNavigation<T = never> {
  private entries: Array<GraphNavigationEntry<T>> = [];
  private index = -1;

  get current(): string | undefined {
    return this.entries[this.index]?.prefix;
  }

  get currentState(): T | undefined {
    return this.entries[this.index]?.state;
  }

  get priorState(): T | undefined {
    return this.entries[this.index - 1]?.state;
  }

  get depth(): number {
    return Math.max(0, this.index);
  }

  get canBack(): boolean {
    return this.index > 0;
  }

  get canForward(): boolean {
    return this.index >= 0 && this.index < this.entries.length - 1;
  }

  reset(prefix: string): void {
    this.entries = [{ prefix }];
    this.index = 0;
  }

  clear(): void {
    this.entries = [];
    this.index = -1;
  }

  push(prefix: string): string {
    if (this.current === prefix) return prefix;
    this.entries.splice(this.index + 1);
    this.entries.push({ prefix });
    this.index = this.entries.length - 1;
    return prefix;
  }

  move(delta: -1 | 1): string | undefined {
    const next = this.index + delta;
    if (next < 0 || next >= this.entries.length) return undefined;
    this.index = next;
    return this.current;
  }

  replace(prefix: string): void {
    if (this.index >= 0) this.entries[this.index].prefix = prefix;
  }

  setState(state: T): void {
    if (this.index >= 0) this.entries[this.index].state = state;
  }

  checkpoint(state: T): void {
    const prefix = this.current;
    if (!prefix) return;
    this.entries.splice(this.index + 1);
    this.entries.push({ prefix, state });
    this.index = this.entries.length - 1;
  }

  snapshot(): GraphNavigationSnapshot<T> {
    return { entries: this.entries.map((entry) => ({ ...entry })), index: this.index };
  }

  restore(snapshot: GraphNavigationSnapshot<T>): void {
    this.entries = snapshot.entries.map((entry) => ({ ...entry }));
    this.index = snapshot.index;
  }
}
