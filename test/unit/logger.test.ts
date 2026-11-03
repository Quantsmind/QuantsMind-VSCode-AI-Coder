import { expect } from 'chai';
import { Logger } from '../../src/security/logger';
import { MemoryLogSink } from './helpers';

suite('logger redaction', () => {
  test('writes timestamped levels to the sink', () => {
    const sink = new MemoryLogSink();
    const logger = new Logger(sink, () => new Date('2026-01-02T03:04:05.000Z'));

    logger.info('activation complete');
    logger.warn('degraded mode');

    expect(sink.lines).to.have.length(2);
    expect(sink.lines[0]).to.equal('2026-01-02T03:04:05.000Z [info] activation complete');
    expect(sink.lines[1]).to.equal('2026-01-02T03:04:05.000Z [warn] degraded mode');
  });

  test('redacts API keys and bearer tokens from every line', () => {
    const sink = new MemoryLogSink();
    const logger = new Logger(sink);

    logger.info('using key sk-abcdefghijklmnopqrstuvwxyz012345');
    logger.warn('Authorization: Bearer abcdefghijklmnopqrstuvwxyz');
    logger.error('failed with {"api_key":"abcdefghijklmnop"}');

    expect(sink.text).to.not.contain('sk-abcdefghijklmnopqrstuvwxyz012345');
    expect(sink.text).to.not.contain('abcdefghijklmnopqrstuvwxyz');
    expect(sink.text).to.contain('[REDACTED]');
  });

  test('includes error name and message but never raw secrets', () => {
    const sink = new MemoryLogSink();
    const logger = new Logger(sink);
    const error = new TypeError('request failed with sk-abcdefghijklmnopqrstuvwxyz012345');

    logger.error('completion failed', error);

    expect(sink.lines[0]).to.contain('completion failed — TypeError: request failed');
    expect(sink.lines[0]).to.not.contain('sk-abcdefghijklmnopqrstuvwxyz012345');
  });

  test('stringifies non-Error detail values', () => {
    const sink = new MemoryLogSink();
    const logger = new Logger(sink);

    logger.error('unexpected', 'plain failure');

    expect(sink.lines[0]).to.contain('unexpected — plain failure');
  });
});
