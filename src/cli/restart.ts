import { Command } from 'commander';
import { IPCClient } from '../daemon/ipc-client.js';
import { writeStopMarker } from './stop.js';

export const restartCommand = new Command('restart')
  .argument('<agent>', 'Agent name to restart')
  .option('--instance <id>', 'Instance ID', 'default')
  .description('Restart a running agent. Re-reads config.json and .env, respawns the PTY. Does NOT restart the daemon process itself. Use `pm2 restart cortextos-daemon` for that.')
  .action(async (agent: string, options: { instance: string }) => {
    const ipc = new IPCClient(options.instance);
    const daemonRunning = await ipc.isDaemonRunning();

    if (!daemonRunning) {
      console.error('Daemon is not running. Start it first: cortextos start');
      process.exit(1);
    }

    console.log(`Restarting agent: ${agent}`);

    // Keep the SessionEnd crash-alert hook from treating this operator action
    // as a real crash while the daemon performs its restart sequence.
    writeStopMarker(options.instance, agent, 'stopped via cortextos restart');

    // Use the daemon's atomic restart path. Sending stop-agent and then
    // start-agent from the CLI races because stop-agent returns immediately
    // after dispatch, before the PTY teardown has completed.
    const restartResponse = await ipc.send({
      type: 'restart-agent',
      agent,
      source: 'cortextos restart',
    });

    if (!restartResponse.success) {
      console.error(`  Restart failed: ${restartResponse.error}`);
      process.exit(1);
    }

    console.log(`  ${restartResponse.data}`);
  });
