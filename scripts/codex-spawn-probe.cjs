// Read-only diagnostic: does node-pty resolve `codex` vs `codex.cmd` on Windows?
// Spawns `codex --version` two ways through cortextos's own node-pty, reports outcome.
const pty = require('C:/Users/lukes/cortextos/node_modules/node-pty');

function probe(file) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (result) => { if (!done) { done = true; resolve(result); } };
    try {
      const p = pty.spawn(file, ['--version'], {
        name: 'xterm-256color', cols: 120, rows: 30,
        cwd: 'C:/Users/lukes', env: process.env,
      });
      p.onData((d) => { out += d; });
      p.onExit(({ exitCode }) => finish({ file, ok: true, exitCode, out: out.trim().slice(0, 200) }));
      setTimeout(() => { try { p.kill(); } catch (e) {} finish({ file, ok: true, exitCode: 'timeout', out: out.trim().slice(0, 200) }); }, 5000);
    } catch (err) {
      finish({ file, ok: false, error: String(err) });
    }
  });
}

(async () => {
  for (const f of ['codex', 'codex.cmd']) {
    const r = await probe(f);
    console.log(JSON.stringify(r));
  }
  process.exit(0);
})();
