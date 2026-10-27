import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const servers = [
  { port: 4173, script: 'scripts/preview.mjs' },
  { port: 4174, script: 'scripts/preview-live-test.mjs' },
  { port: 4175, script: 'scripts/preview-layout-test.mjs' },
];

async function assertPortAvailable(port: number): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const probe = createServer();
    probe.once('error', error => reject(new Error(`Test port ${port} is already in use or unavailable. Stop the existing preview before running tests; no existing process will be reused or stopped. ${error.message}`)));
    probe.listen({ host: '127.0.0.1', port, exclusive: true }, () => probe.close(error => error ? reject(error) : resolvePromise()));
  });
}

async function waitForExit(child: ChildProcess, milliseconds: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return await new Promise<boolean>(resolvePromise => {
    const finish = (exited: boolean) => { clearTimeout(timer); child.removeListener('exit', onExit); resolvePromise(exited); };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), milliseconds);
    child.once('exit', onExit);
  });
}

async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (child.connected) child.send({ type: 'shutdown' }, () => {});
  if (await waitForExit(child, 4000)) return;
  // This is the direct Node process created below, never a user process or PID search.
  child.kill('SIGKILL');
  if (!await waitForExit(child, 2000)) {
    child.disconnect();
    throw new Error(`The test preview process ${child.pid} did not exit after bounded shutdown.`);
  }
}

async function startServer(port: number, script: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, [resolve(root, script)], {
    cwd: root,
    env: { ...process.env, PORT: String(port) },
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  const capture = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-12000); };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
  try {
    await new Promise<void>((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error(`The test preview on port ${port} did not become ready.\n${output}`)), 30000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`The test preview on port ${port} exited with ${code}.\n${output}`)); });
      child.on('message', message => {
        if (message && typeof message === 'object' && 'type' in message && message.type === 'ready' && 'port' in message && message.port === port) {
          clearTimeout(timer); resolvePromise();
        }
      });
    });
    return child;
  } catch (error) { await stopServer(child); throw error; }
}

export default async function globalSetup() {
  // Check every port before any server starts or disposable files are refreshed.
  await Promise.all(servers.map(server => assertPortAvailable(server.port)));
  const children: ChildProcess[] = [];
  try {
    for (const server of servers) children.push(await startServer(server.port, server.script));
  } catch (error) { await Promise.all(children.map(stopServer)); throw error; }
  return async () => { await Promise.all(children.map(stopServer)); };
}
