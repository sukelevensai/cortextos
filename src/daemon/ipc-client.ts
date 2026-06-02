import type { IPCRequest, IPCResponse } from '../types/index.js';
import { getIpcPath } from '../utils/paths.js';

/**
 * Thin client wrapper for talking to the daemon over its Unix/named-pipe IPC
 * socket. Extracted from ipc-server.ts (GAP-0088) so CLI commands and other
 * callers pull this ~50-line socket wrapper instead of the full IPC server
 * (AgentManager, cron handlers, fleet-health cache, etc.).
 */
export class IPCClient {
  private socketPath: string;

  constructor(instanceId: string = 'default') {
    this.socketPath = getIpcPath(instanceId);
  }

  /**
   * Send a command to the daemon and get the response.
   */
  async send(request: IPCRequest): Promise<IPCResponse> {
    const { createConnection } = require('net');

    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath, () => {
        socket.write(JSON.stringify(request));
      });

      let data = '';
      socket.on('data', (chunk: Buffer) => {
        data += chunk.toString();
      });

      socket.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error('Invalid response from daemon'));
        }
      });

      socket.on('error', (err: Error) => {
        if ((err as any).code === 'ECONNREFUSED' || (err as any).code === 'ENOENT') {
          resolve({
            success: false,
            error: 'Daemon is not running. Start it with: cortextos start',
          });
        } else {
          reject(err);
        }
      });

      // Timeout after 5 seconds
      socket.setTimeout(5000, () => {
        socket.destroy();
        reject(new Error('IPC request timed out'));
      });
    });
  }

  /**
   * Check if the daemon is running.
   */
  async isDaemonRunning(): Promise<boolean> {
    try {
      const response = await this.send({ type: 'status' });
      return response.success;
    } catch {
      return false;
    }
  }
}
