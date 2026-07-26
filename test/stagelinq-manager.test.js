const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');

const StagelinqManager = require('../stagelinq-manager');

test('handles and detaches stagelinq logger error events', () => {
    const manager = new StagelinqManager();
    const logger = new EventEmitter();
    const originalConsoleError = console.error;
    const originalConsoleWarn = console.warn;
    const logged = [];
    console.error = (...args) => logged.push(args.join(' '));
    console.warn = (...args) => logged.push(args.join(' '));

    try {
        manager._attachStagelinqLogger(logger);
        assert.doesNotThrow(() => logger.emit('error', new Error('protocol parse failed')));
        logger.emit('warn', 'database download failed');
        assert.equal(logger.listenerCount('error'), 1);
        assert.equal(logger.listenerCount('warn'), 1);
        assert.match(logged[0], /protocol parse failed/);
        assert.match(logged[1], /database download failed/);

        manager._detachStagelinqLogger();
        assert.equal(logger.listenerCount('error'), 0);
        assert.equal(logger.listenerCount('warn'), 0);
    } finally {
        console.error = originalConsoleError;
        console.warn = originalConsoleWarn;
    }
});
