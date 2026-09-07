export type ScheduledTask = () => Promise<void>;
export type SchedulerErrorHandler = (
  name: string,
  error: unknown,
) => void | Promise<void>;

interface Registration {
  intervalMs: number;
  task: ScheduledTask;
  timer: NodeJS.Timeout | undefined;
  running: boolean;
}

export class Scheduler {
  private readonly registrations = new Map<string, Registration>();
  private started = false;
  private stopped = false;

  constructor(
    private readonly onError: SchedulerErrorHandler = () => undefined,
  ) {}

  register(name: string, intervalMs: number, task: ScheduledTask): void {
    if (this.registrations.has(name))
      throw new Error(`La tarea ${name} ya está registrada.`);
    if (!Number.isFinite(intervalMs) || intervalMs <= 0)
      throw new Error("El intervalo debe ser positivo.");
    this.registrations.set(name, {
      intervalMs,
      task,
      timer: undefined,
      running: false,
    });
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    for (const [name, registration] of this.registrations) {
      registration.timer = setInterval(
        () => void this.run(name),
        registration.intervalMs,
      );
    }
  }

  async run(name: string): Promise<boolean> {
    const registration = this.registrations.get(name);
    if (!registration) throw new Error(`Tarea no registrada: ${name}`);
    if (this.stopped || registration.running) return false;
    registration.running = true;
    try {
      await registration.task();
    } catch (error) {
      await this.onError(name, error);
    } finally {
      registration.running = false;
    }
    return true;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const registration of this.registrations.values()) {
      if (registration.timer) clearInterval(registration.timer);
      registration.timer = undefined;
    }
  }
}
