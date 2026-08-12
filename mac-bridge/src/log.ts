export type LogLevel = "debug" | "info" | "warn" | "error";

const severity: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export class Logger {
  constructor(private readonly minimum: LogLevel = "info") {}

  debug(message: string, data?: unknown) { this.write("debug", message, data); }
  info(message: string, data?: unknown) { this.write("info", message, data); }
  warn(message: string, data?: unknown) { this.write("warn", message, data); }
  error(message: string, data?: unknown) { this.write("error", message, data); }

  private write(level: LogLevel, message: string, data?: unknown) {
    if (severity[level] < severity[this.minimum]) return;
    const record = { time: new Date().toISOString(), level, message, ...(data === undefined ? {} : { data }) };
    const line = JSON.stringify(record);
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  }
}

