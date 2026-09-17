// Integration-only diagnostics for one real guest process; no SDK stream emulation.
import { Worker, MessageChannel } from 'node:worker_threads';
import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { openSync, writeSync, fsyncSync, closeSync, readFileSync, mkdirSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { runtimeSourceUrl, runtimeSourcePath } from './runtime-source.mjs';

const errorInfo = error => ({ name: error?.name || 'Error', message: String(error?.message ?? error), code: error?.code ?? null });
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function abortable(promise, signal) {
  return new Promise((done, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(done, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function within(promise, milliseconds, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), milliseconds); }),
  ]).finally(() => clearTimeout(timer));
}

function writeAll(fd, bytes, persisted) {
  for (let offset = 0; offset < bytes.length;) {
    const count = writeSync(fd, bytes, offset, bytes.length - offset);
    if (count === 0) throw new Error('Diagnostic sink made no write progress');
    offset += count;
    persisted?.(count);
  }
}

function saveReceipt(path, receipt) {
  const temporary = path + '.tmp';
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    writeAll(fd, Buffer.from(JSON.stringify(receipt, null, 2) + '\n'));
    fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(temporary, path);
}

/**
 * A fresh SQLite snapshot FS worker plus the normal runtime process workers.
 * Synchronous regular-file sinks preserve exact received bytes without another
 * JS write queue. This is low-volume diagnostic collection, not P2 backpressure.
 * Kernel messages have no stdout/stderr EOF events: worker exit is an observation
 * boundary, never an invented stream-end acknowledgment or end-to-end loss proof.
 */
export async function runHeadlessProcessProbe({ directory, name, timeoutMs = 180000,
  cleanupTimeoutMs = 5000, provenance = {}, exercise }) {
  const runID = randomUUID();
  const root = resolve(directory, `${name}-${runID}`);
  mkdirSync(root, { recursive: true });
  mkdirSync(resolve(root, 'storage'));
  const receiptPath = resolve(root, 'receipt.json');
  const receipt = {
    runID, name, root, startedAt: new Date().toISOString(), node: process.version,
    runtimeSource: runtimeSourcePath(), provenance, timeoutMs, cleanupTimeoutMs,
    result: 'PENDING', primaryFailure: null, secondaryFailures: [], stages: [],
    lastCompletedStage: null, workers: [], exit: null, stdin: [], channels: {},
    cleanup: { completed: false }, receiptPersistence: 'fsynced file then atomic rename; not a power-loss guarantee',
  };
  const controller = new AbortController();
  const changed = new EventEmitter();
  const workers = [];
  const sinks = {};
  let kernel;
  let pid;
  let exitResolve;
  let forced = false;
  let closing = false;
  const exited = new Promise(done => { exitResolve = done; });
  const stage = (name, detail = {}) => {
    receipt.lastCompletedStage = name;
    receipt.stages.push({ name, at: new Date().toISOString(), ...detail });
  };
  const fail = (kind, error) => {
    const failure = { kind, at: new Date().toISOString(), stage: receipt.lastCompletedStage, ...errorInfo(error) };
    if (!receipt.primaryFailure) {
      receipt.primaryFailure = failure;
      controller.abort(error instanceof Error ? error : new Error(String(error)));
    } else receipt.secondaryFailures.push(failure);
  };
  const output = (channel, chunk) => {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const info = receipt.channels[channel];
    info.receivedBytes += bytes.length;
    info.chunks++;
    sinks[channel].receivedHash.update(bytes);
    if (sinks[channel].fd !== undefined && !info.errors.length) {
      try { writeAll(sinks[channel].fd, bytes, count => { info.persistedBytes += count; }); }
      catch (error) { info.errors.push(errorInfo(error)); fail('sink.write', error); }
    }
    if (info.chunks === 1) stage(`${channel}.first-output`, { bytes: bytes.length });
    changed.emit('change');
  };
  const ownWorker = (worker, role, processID = null) => {
    const info = { role, pid: processID, messages: {}, wireStdoutBytes: 0, wireStderrBytes: 0,
      guestExitMessage: false, terminationRequested: false, terminationJoined: false,
      exitObserved: false, exitCode: null, errors: [] };
    const owned = { worker, info, termination: null };
    workers.push(owned);
    receipt.workers.push(info);
    for (const type of ['error', 'messageerror']) worker.on(type, error => {
      info.errors.push({ type, ...errorInfo(error) });
      fail(`worker.${type}`, error);
    });
    worker.on('exit', code => {
      info.exitObserved = true;
      info.exitCode = code;
      if (!info.terminationRequested && !info.guestExitMessage) fail('worker.unexpected-exit', new Error(`${role} worker exited ${code}`));
      changed.emit('change');
    });
    worker.on('message', message => {
      info.messages[message.type] = (info.messages[message.type] || 0) + 1;
      if (message.type === 'stdout') info.wireStdoutBytes += Buffer.byteLength(message.chunk);
      if (message.type === 'stderr') info.wireStderrBytes += Buffer.byteLength(message.chunk);
      if (message.type === 'exit') info.guestExitMessage = true;
    });
    return owned;
  };
  const terminate = owned => {
    if (owned.termination) return owned.termination;
    owned.info.terminationRequested = true;
    try {
      owned.termination = owned.worker.terminate().then(code => {
        owned.info.terminationJoined = true;
        return code;
      });
    } catch (error) { owned.termination = Promise.reject(error); }
    // Kernel.finalize does not await its handle's terminate method.
    owned.termination.catch(error => fail('worker.terminate', error));
    return owned.termination;
  };
  const timer = setTimeout(() => fail('timeout', new Error(`Probe exceeded ${timeoutMs} ms`)), timeoutMs);
  const text = channel => readFileSync(receipt.channels[channel].path, 'utf8');
  const waitForOutput = (channel, marker, rejectMarker) => new Promise((done, reject) => {
    const cleanup = () => {
      changed.removeListener('change', check);
      controller.signal.removeEventListener('abort', abort);
    };
    const abort = () => { cleanup(); reject(controller.signal.reason); };
    const check = () => {
      if (controller.signal.aborted) return abort();
      try {
        const content = text(channel);
        if (rejectMarker && content.includes(rejectMarker)) throw new Error(`${channel} reported ${rejectMarker}; inspect channel log`);
        if (content.includes(marker)) { cleanup(); done(); }
        else if (receipt.exit) throw new Error(`Process exited before ${channel} marker ${marker}`);
      } catch (error) { cleanup(); reject(error); }
    };
    changed.on('change', check);
    controller.signal.addEventListener('abort', abort, { once: true });
    check();
  });
  try {
    for (const channel of ['stdout', 'stderr']) {
      receipt.channels[channel] = { path: resolve(root, `${channel}.bin`), receivedBytes: 0,
        persistedBytes: 0, chunks: 0, errors: [], fsynced: false, closed: false,
        streamEnd: 'not signaled by Kernel protocol', observationComplete: false };
      sinks[channel] = { receivedHash: createHash('sha256') };
      try { sinks[channel].fd = openSync(receipt.channels[channel].path, 'wx', 0o600); }
      catch (error) { receipt.channels[channel].errors.push(errorInfo(error)); fail('sink.open', error); throw error; }
    }
    await abortable((async () => {
      const { Kernel } = await import(runtimeSourceUrl('packages/kernel-host/kernel.js'));
      const { createKernelFs } = await import(runtimeSourceUrl('packages/kernel-host/kernel-fs.js'));
      controller.signal.throwIfAborted();
      const fsWorker = new Worker(new URL('./sqlite-headless-fs.mjs', import.meta.url), { workerData: { directory: resolve(root, 'storage') } });
      ownWorker(fsWorker, 'filesystem');
      let dispatch = () => {};
      await abortable(new Promise(done => fsWorker.on('message', message => {
        if (message.type === 'ready') done();
        else if (['fs-write-large-ok', 'fs-write-large-err', 'fs-write-batch-ok', 'fs-write-batch-err'].includes(message.type)) dispatch(message);
        else fail('worker.unhandled-message', new Error(`Filesystem message ${message.type}`));
      })), controller.signal);
      const bridge = createKernelFs(fsWorker);
      dispatch = bridge.onMessage;
      kernel = new Kernel({ fs: bridge.fs,
        stdout: chunk => output('stdout', chunk), stderr: chunk => output('stderr', chunk),
        spawnWorker(info) {
          const worker = new Worker(runtimeSourceUrl('scripts/process-worker.mjs'));
          const owned = ownWorker(worker, 'process', info.pid);
          worker.on('message', message => {
            try {
              if (!info.on[message.type]) throw new Error(`Unhandled process message ${message.type}`);
              info.on[message.type](message);
            } catch (error) { fail('worker.dispatch', error); }
          });
          const { port1, port2 } = new MessageChannel();
          fsWorker.postMessage({ type: 'fs-register', client: info.pid, sab: info.sab, port: port2 }, [port2]);
          worker.postMessage({ type: 'init', sab: info.sab, spec: info.spec, fsPort: port1 }, [port1]);
          return { postMessage: message => worker.postMessage(message), terminate() {
            void terminate(owned);
            if (!closing) fsWorker.postMessage({ type: 'fs-unregister', client: info.pid });
          } };
        },
      });
      kernel.onListen = (port, owner) => stage('listener', { port, pid: owner });
      kernel.onStdioOverflow = (owner, channel) => fail('stdio.overflow', new Error(`pid ${owner} channel ${channel}`));
      kernel.onProcExit = (owner, result) => {
        if (owner !== pid) return;
        receipt.exit = { pid: owner, code: result.code, signal: result.signal,
          forced, natural: !forced && result.signal === null };
        stage('process.exit', receipt.exit);
        exitResolve(receipt.exit);
        if (!forced && (result.code !== 0 || result.signal !== null)) fail('process.exit', new Error(`Guest exited ${result.code}, signal ${result.signal}`));
        changed.emit('change');
      };
      kernel.installCoreutils();
      stage('filesystem.ready');
      await exercise({ kernel, stage, text, waitForOutput, signal: controller.signal, root,
        launch(command, args, options = {}) {
          controller.signal.throwIfAborted();
          if (pid !== undefined) throw new Error('Probe supports exactly one top-level launch');
          if (options.capture) throw new Error('Exit-only capture cannot be used with live probe diagnostics');
          pid = kernel.launch(command, args, { ...options, capture: false });
          if (pid < 0) throw new Error(`Command not found: ${command}`);
          stage('process.launched', { pid, command, args });
          return pid;
        },
        closeStdin() {
          controller.signal.throwIfAborted();
          const posted = kernel.sendStdin(pid, null);
          receipt.stdin.push({ at: new Date().toISOString(), kind: 'EOF', posted,
            delivery: 'postMessage return only; guest receipt not acknowledged' });
          if (!posted) throw new Error('Stdin EOF could not be posted');
          stage('stdin.eof-posted');
        },
        waitForExit: () => abortable(exited, controller.signal),
        request: (port, request, milliseconds = 5000) => abortable(within(kernel.handleHttpRequest(port, request), milliseconds, 'HTTP request timeout'), controller.signal),
      });
      if (!receipt.exit || !receipt.exit.natural || receipt.exit.code !== 0) throw new Error('Exercise completed without natural guest exit 0');
      stage('exercise.complete');
    })(), controller.signal);
  } catch (error) {
    if (!receipt.primaryFailure) fail('exercise', error);
  } finally {
    clearTimeout(timer);
    closing = true;
    receipt.cleanup.startedAt = new Date().toISOString();
    if (pid !== undefined && kernel?.procs.has(pid)) {
      forced = true;
      receipt.cleanup.forcedStopRequested = true;
      try { kernel.stop(pid); } catch (error) { fail('cleanup.stop', error); }
    }
    try {
      await within(Promise.all(workers.map(terminate)), cleanupTimeoutMs, 'Worker cleanup deadline exceeded');
    } catch (error) {
      fail('cleanup.workers', error);
      // Termination has been requested; an incomplete join must not keep the host alive.
      for (const owned of workers) if (!owned.info.terminationJoined) owned.worker.unref();
    }
    receipt.cleanup.completed = workers.every(owned => owned.info.terminationJoined && owned.info.exitObserved);
    receipt.cleanup.finishedAt = new Date().toISOString();
    if (!receipt.cleanup.completed) fail('cleanup.incomplete', new Error('Not all worker exits and termination joins were observed'));
    for (const channel of ['stdout', 'stderr']) {
      const info = receipt.channels[channel];
      if (!info) continue;
      info.receivedSha256 = sinks[channel].receivedHash.digest('hex');
      info.observationComplete = receipt.cleanup.completed;
      if (sinks[channel].fd !== undefined) {
        try { fsyncSync(sinks[channel].fd); info.fsynced = true; }
        catch (error) { info.errors.push(errorInfo(error)); fail('sink.flush', error); }
        try { closeSync(sinks[channel].fd); info.closed = true; }
        catch (error) { info.errors.push(errorInfo(error)); fail('sink.close', error); }
        try {
          const bytes = readFileSync(info.path);
          info.fileBytes = bytes.length;
          info.persistedSha256 = sha256(bytes);
          if (info.receivedBytes !== info.persistedBytes || info.fileBytes !== info.persistedBytes || info.receivedSha256 !== info.persistedSha256)
            throw new Error(`${channel} received/persisted byte or hash mismatch`);
        } catch (error) { info.errors.push(errorInfo(error)); fail('sink.integrity', error); }
      }
      info.workerMessageBytes = receipt.workers.reduce((sum, worker) => sum + worker[channel === 'stdout' ? 'wireStdoutBytes' : 'wireStderrBytes'], 0);
      // Includes nested captured children: a mismatch is evidence to assess, not proof of a transport drop.
      info.workerToSinkBytesMatch = info.workerMessageBytes === info.receivedBytes;
    }
    receipt.result = receipt.primaryFailure ? (receipt.primaryFailure.kind === 'timeout' ? 'TIMEOUT' : 'FAIL') : 'PASS';
    receipt.finishedAt = new Date().toISOString();
    try { saveReceipt(receiptPath, receipt); }
    catch (error) {
      fail('receipt.write', error);
      receipt.result = 'FAIL';
      // A caller must print this returned failure; never claim an unwritten receipt exists.
      return { receipt, receiptPath: null, receiptWriteError: errorInfo(error), intendedReceiptPath: receiptPath };
    }
  }
  return { receipt, receiptPath, receiptSha256: sha256(readFileSync(receiptPath)) };
}
