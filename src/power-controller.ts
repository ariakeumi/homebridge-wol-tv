import type { Logging } from 'homebridge';

import type { DeviceConfig } from './config.js';
import { probeHost, sendWake, shutdownHost } from './network.js';

export class PowerBusyError extends Error {}

export interface PowerDependencies {
  probe: typeof probeHost;
  wake: typeof sendWake;
  shutdown: typeof shutdownHost;
  now: () => number;
}

export class PowerController {
  private online = false;
  private known = false;
  private failures = 0;
  private probeError?: Error;
  private transition?: { target: boolean; deadline: number };
  private command?: { target: boolean; pending: Promise<void> };
  private polling?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private stopped = false;
  private started = false;
  private readonly abort = new AbortController();
  private readonly deps: PowerDependencies;

  constructor(
    private readonly config: DeviceConfig,
    private readonly log: Pick<Logging, 'info' | 'warn' | 'debug'>,
    private readonly onUpdate: (active: boolean | Error) => void,
    dependencies: Partial<PowerDependencies> = {},
  ) {
    this.deps = { probe: probeHost, wake: sendWake, shutdown: shutdownHost, now: Date.now, ...dependencies };
  }

  get active(): boolean {
    if (this.transition) {
      return this.transition.target;
    }
    if (this.probeError) {
      throw this.probeError;
    }
    if (!this.known) {
      throw new Error('Waiting for the first host status probe.');
    }
    return this.online;
  }

  start(): void {
    if (this.started || this.stopped) {
      return;
    }
    this.started = true;
    const tick = async (): Promise<void> => {
      await this.refresh();
      if (!this.stopped) {
        this.timer = setTimeout(() => { void tick(); }, this.config.pollInterval * 1000);
        this.timer.unref();
      }
    };
    void tick();
  }

  stop(): void {
    this.stopped = true;
    this.generation++;
    clearTimeout(this.timer);
    this.abort.abort();
  }

  refresh(): Promise<void> {
    if (this.stopped) {
      return Promise.resolve();
    }
    if (this.polling) {
      return this.polling;
    }
    const generation = this.generation;
    this.polling = this.poll(generation).finally(() => { this.polling = undefined; });
    return this.polling;
  }

  private async poll(generation: number): Promise<void> {
    try {
      const reachable = await this.deps.probe(this.config, this.abort.signal);
      // A status check begun before a power command must not undo that command.
      if (this.stopped || generation !== this.generation) {
        return;
      }
      this.probeError = undefined;
      if (reachable) {
        this.failures = 0;
        this.online = true;
        this.known = true;
      } else {
        this.failures++;
        if (!this.known || this.failures >= this.config.offlineThreshold) {
          this.online = false;
          this.known = true;
        }
      }
      if (this.transition) {
        // Confirm off only from fresh consecutive failures, even when previously offline.
        const confirmed = this.transition.target
          ? reachable
          : !reachable && this.failures >= this.config.offlineThreshold;
        if (confirmed) {
          this.log.info(`[${this.config.name}] Power ${this.transition.target ? 'on' : 'off'} confirmed.`);
          this.transition = undefined;
        } else if (this.deps.now() >= this.transition.deadline) {
          this.log.warn(`[${this.config.name}] Power ${this.transition.target ? 'on' : 'off'} was not confirmed before the grace period expired; restoring detected state.`);
          this.transition = undefined;
        }
      }
      this.publish();
    } catch (error) {
      if (this.stopped || generation !== this.generation) {
        return;
      }
      const failure = error instanceof Error ? error : new Error('Status probe failed.');
      if (this.probeError?.message !== failure.message) {
        this.log.warn(`[${this.config.name}] ${failure.message}`);
      }
      this.probeError = failure;
      // Probe execution errors cannot keep optimistic state alive indefinitely.
      if (this.transition && this.deps.now() >= this.transition.deadline) {
        this.transition = undefined;
      }
      this.publish();
    }
  }

  setPower(target: boolean): Promise<void> {
    if (this.stopped) {
      return Promise.reject(new Error('Plugin is shutting down.'));
    }
    if (this.command) {
      return this.command.target === target
        ? this.command.pending
        : Promise.reject(new PowerBusyError('Another power command is still being sent.'));
    }
    if (this.transition?.target === target || (!this.transition && this.known && !this.probeError && this.online === target)) {
      return Promise.resolve();
    }
    if (!target && !this.config.shutdown) {
      return Promise.reject(new Error('Power off is not configured. Set shutdown to a command or HTTP endpoint.'));
    }
    this.generation++;
    const pending = this.send(target).finally(() => { this.command = undefined; });
    this.command = { target, pending };
    return pending;
  }

  private async send(target: boolean): Promise<void> {
    try {
      await (target ? this.deps.wake : this.deps.shutdown)(this.config, this.abort.signal);
      if (this.stopped) {
        return;
      }
      this.generation++;
      this.failures = 0;
      this.transition = {
        target,
        deadline: this.deps.now() + (target ? this.config.onGracePeriod : this.config.offGracePeriod) * 1000,
      };
      this.log.info(`[${this.config.name}] ${target ? 'WOL packet sent' : 'Shutdown request accepted'}; waiting for host status.`);
      this.publish();
    } catch (error) {
      if (!this.stopped) {
        this.publish();
      }
      throw error;
    }
  }

  private publish(): void {
    let value: boolean | Error;
    try {
      value = this.active;
    } catch (error) {
      value = error instanceof Error ? error : new Error('Host status unavailable.');
    }
    this.onUpdate(value);
  }
}
