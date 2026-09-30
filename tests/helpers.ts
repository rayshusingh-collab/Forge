import type { LogRecord, LogSink, TextWriter } from '../src/logging/index.ts';

export class CapturingWriter implements TextWriter {
  text = '';

  write(text: string): void {
    this.text += text;
  }
}

export class MemorySink implements LogSink {
  readonly records: LogRecord[] = [];

  write(record: LogRecord): void {
    this.records.push(record);
  }
}
