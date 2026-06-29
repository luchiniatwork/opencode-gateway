export class TargetUnavailableError extends Error {
  readonly targetId: string;

  constructor(targetId: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TargetUnavailableError";
    this.targetId = targetId;
  }
}
