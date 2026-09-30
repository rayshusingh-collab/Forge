import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { REDACTED, createConsoleSink, createLogger, formatLogRecord } from '../src/logging/index.ts';
import { CapturingWriter, MemorySink } from './helpers.ts';

const fixedClock = (): Date => new Date('2026-01-02T03:04:05.678Z');

describe('logger', () => {
  it('filters records below the configured level', () => {
    const sink = new MemorySink();
    const logger = createLogger({ level: 'warn', sink });

    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    assert.deepEqual(
      sink.records.map((record) => record.level),
      ['warn', 'error'],
    );
  });

  it('emits every level at debug', () => {
    const sink = new MemorySink();
    const logger = createLogger({ level: 'debug', sink });

    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    assert.equal(sink.records.length, 4);
  });

  it('timestamps records using the injected clock', () => {
    const sink = new MemorySink();
    createLogger({ level: 'info', sink, clock: fixedClock }).info('hello');
    assert.equal(sink.records[0]?.timestamp.toISOString(), '2026-01-02T03:04:05.678Z');
  });

  it('nests scopes for child loggers and shares the level', () => {
    const sink = new MemorySink();
    const child = createLogger({ level: 'info', sink, scope: 'forge' }).child('execution');

    child.debug('hidden');
    child.info('visible');

    assert.equal(sink.records.length, 1);
    assert.equal(sink.records[0]?.scope, 'forge:execution');
  });

  it('redacts sensitive context keys', () => {
    const sink = new MemorySink();
    createLogger({ level: 'info', sink }).info('connecting', {
      apiKey: 'sk-123',
      password: 'hunter2',
      authToken: 'abc',
      host: 'localhost',
    });

    assert.deepEqual(sink.records[0]?.context, {
      apiKey: REDACTED,
      password: REDACTED,
      authToken: REDACTED,
      host: 'localhost',
    });
  });
});

describe('console sink', () => {
  it('formats a readable single line', () => {
    const line = formatLogRecord({
      timestamp: fixedClock(),
      level: 'warn',
      scope: 'execution',
      message: 'Process did not succeed',
      context: { command: 'node', exitCode: 3, note: 'has spaces' },
    });
    assert.equal(
      line,
      '2026-01-02T03:04:05.678Z WARN  [execution] Process did not succeed command=node exitCode=3 note="has spaces"',
    );
  });

  it('writes one line per record to the given writer', () => {
    const writer = new CapturingWriter();
    const logger = createLogger({ level: 'info', sink: createConsoleSink(writer), clock: fixedClock });

    logger.info('first');
    logger.error('second');

    assert.equal(writer.text, '2026-01-02T03:04:05.678Z INFO  first\n2026-01-02T03:04:05.678Z ERROR second\n');
  });
});
