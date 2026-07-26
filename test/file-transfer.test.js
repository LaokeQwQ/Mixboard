const test = require('node:test');
const assert = require('node:assert/strict');

const { FileTransfer } = require('stagelinq/dist/services/FileTransfer');
const { ReadContext } = require('stagelinq/dist/utils/ReadContext');
const { WriteContext } = require('stagelinq/dist/utils/WriteContext');

function fileTransferContext(transactionId, messageId, writePayload = () => {}) {
    const writer = new WriteContext();
    writer.writeFixedSizedString('fltx');
    writer.writeUInt32(transactionId);
    writer.writeUInt32(messageId);
    writePayload(writer);
    const buffer = writer.getBuffer();
    const data = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    return new ReadContext(data, false);
}

function createFileTransfer() {
    return new FileTransfer('127.0.0.1', 0, {});
}

test('parses a FileTransferId reply with a non-zero transaction id', () => {
    const service = createFileTransfer();
    const ctx = fileTransferContext(7, 4, writer => {
        writer.writeUInt32(0);
        writer.writeUInt32(123456);
        writer.writeUInt32(1);
    });

    const parsed = service.parseData(ctx);

    assert.deepEqual(parsed, {
        id: 4,
        message: { size: 123456, transactionId: 7, transferId: 1 },
    });
});

test('keeps support for the legacy request-shaped timecode packet', () => {
    const service = createFileTransfer();
    const ctx = fileTransferContext(9, 0x7d2, writer => writer.writeUInt32(0));

    assert.deepEqual(service.parseData(ctx), {
        id: 0,
        message: { timecode: 9, transactionId: 9 },
    });
});

test('writes out-of-order and duplicate chunks by byte offset', () => {
    const service = createFileTransfer();
    service.receivedFile = new WriteContext({ size: 6, autoGrow: false });
    service.receivedRanges = [];

    service.messageHandler({ id: 5, message: { transactionId: 3, offset: 3, size: 3, data: Buffer.from('def') } });
    assert.equal(service.receivedFile.sizeLeft(), 3);
    service.messageHandler({ id: 5, message: { transactionId: 3, offset: 0, size: 3, data: Buffer.from('abc') } });
    service.messageHandler({ id: 5, message: { transactionId: 3, offset: 0, size: 3, data: Buffer.from('abc') } });

    assert.equal(service.receivedFile.isEOF(), true);
    assert.equal(service.receivedFile.getBuffer().toString(), 'abcdef');
});

test('downloads through non-zero transaction id and reports completion', async () => {
    const service = createFileTransfer();
    const progress = [];
    let chunkRequest;
    let completedTransactionId;

    service.on('fileTransferProgress', event => progress.push(event.percentComplete));
    service.requestFileTransferId = async () => {
        setImmediate(() => service.emit('message', {
            id: 4,
            message: { size: 6, transactionId: 11, transferId: 1 },
        }));
    };
    service.requestChunkRange = async (...args) => {
        chunkRequest = args;
        setImmediate(() => {
            service.messageHandler({ id: 5, message: { transactionId: 11, offset: 3, size: 3, data: Buffer.from('def') } });
            service.messageHandler({ id: 5, message: { transactionId: 11, offset: 0, size: 3, data: Buffer.from('abc') } });
        });
    };
    service.signalTransferComplete = async transactionId => {
        completedTransactionId = transactionId;
    };

    const result = await service.getFile('/USB/Engine Library/Database2/m.db');

    assert.equal(Buffer.from(result).toString(), 'abcdef');
    assert.deepEqual(chunkRequest, [11, 1, 0, 0]);
    assert.equal(completedTransactionId, 11);
    assert.deepEqual(progress, [0, 100]);
    assert.equal(service.receivedFile, null);
    assert.equal(service._available, true);
});

test('rejects invalid chunk ranges with protocol context', () => {
    const service = createFileTransfer();
    service.receivedFile = new WriteContext({ size: 4, autoGrow: false });
    service.receivedRanges = [];

    assert.throws(
        () => service.messageHandler({ id: 5, message: { transactionId: 2, offset: 3, size: 2, data: Buffer.from('xx') } }),
        /Invalid FileTransfer chunk range offset=3 size=2 data=2 total=4/,
    );
});

test('aborts a message wait immediately on protocol errors', async () => {
    const service = createFileTransfer();
    const pending = service.waitForMessage(4);

    service.emit('protocolError', new Error('invalid transaction header'));

    await assert.rejects(pending, /invalid transaction header/);
    assert.equal(service.listenerCount('message'), 0);
    assert.equal(service.listenerCount('protocolError'), 1);
});
