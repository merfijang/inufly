# InuFly

A real fruit-fly brain (the full FlyEM MaleCNS v1.0 connectome, 166,700 neurons) runs a Shiba Inu down a stripped-down Subway Surfers track: three lanes, the obstacles of the original game (low barriers, roadblocks, high barriers, parked trains, trains with ramps onto their roofs, oncoming trains), and a dog that keeps speeding up. It only gets a run when the token's trading fees pay for one: every `SOL_PER_ATTEMPT` SOL of creator fees is one run, and every run is one sample of an evolution strategy over the fly's readout, so the dog really learns from the runs traders pay for. Everyone watches the same dog at inufly.xyz.

Built on [alextitonis/fly.ai](https://github.com/alextitonis/fly.ai) (connectome export and simulation) and FlappyFly (fee watcher, trainer, live stream).

## What is real

- Connectome weights are frozen. 36 numbers learn: for each of left, right, jump and roll, 8 readout weights and a bias.
- The dog sees the track only through the fly's own visual neurons, one quantity per population and on the side where it is:
  - something to jump in its lane (low barrier, roadblock) → LC4 (the looming cells that drive the giant-fibre escape jump),
  - something to roll under (high barrier, roadblock) → LC6,
  - a train in its lane, parked or oncoming → LPLC1,
  - the lane to the left / right blocked by a train or the track edge → LPLC2 on that side.
- Which populations each move is read from is measured at the first start (`src/core/calibrate.ts`): the jump reads the 8 cell types that follow the barrier signal most closely; a lane change reads 4 that follow the train signal and 4 that tell a blocked left from a blocked right.
- Learning: antithetic ES (`server/trainer.ts`). The two halves of a pair run the same course with the same noise, and only the difference between them counts, so how hard a course was cancels out.

## Layout

```
brain/            connectome export (server only; 57 MB)
public/           site assets: brain/meta.bin (neuron labels), models/shiba.glb
src/game/         the runner: seeded course, lanes, jump, collisions (shared with the site)
src/core/         connectome sim, sensing, policy, calibration
src/shared/       wire protocol, which neurons the site draws
src/site/         spectator site (Vite, three.js)
server/           fee watcher, trainer, compute + playback loops, WebSocket
deploy/           systemd unit, Caddy block, env example
```

## Run locally

```bash
npm install
npm run server      # fly server on :8788, fake fees (FEE_SOURCE=mock); calibrates on first start (~1 min)
npm run dev         # site on :5173, connects to ws://localhost:8788/ws
npm test
npm run typecheck
```

## Two clocks

InuFly splits its work in two, so viewers always get a steady stream even when the CPU is busy:

- **compute**: runs each paid attempt through the connectome as fast as the leftover CPU allows (usually slower than real time) and records every step;
- **playback**: streams the recorded run to viewers at exactly 50 steps a second.

Learning happens when a run finishes computing. Viewers see each run a little after it was computed; the next one is computed while the current one plays. Between runs the idle brain only ticks while someone is watching.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `FEE_SOURCE` | `mock` | `mock` or `solana` |
| `FEE_TOKEN` | – | pump.fun coin; its creator fee vaults are found automatically (the server waits if it has not launched yet) |
| `FEE_WALLET` | – | or: comma-separated addresses the fees land in |
| `SOL_PER_ATTEMPT` | `0.001` | fees per run |
| `SOLANA_RPC_URL` | public mainnet | use a private RPC in production |
| `POLL_MS` | `5000` | how often the vaults are read |
| `ADMIN_TOKEN` | – | enables `POST /admin/attempts?n=…` with header `x-admin-token` |
| `READOUT_PER_ACTION` | `8` | populations each move is read from (only used at the first start) |
| `CAP_SECONDS` | `180` | longest run |
| `PORT` / `HOST` | `8788` / `0.0.0.0` | |
| `STATE_FILE` | `data/state.json` | learning state, queue, history |
| `BRAIN_DIR` | `brain` | connectome files |

Site build variables: `VITE_SERVER_URL` (wss URL of the fly server), `VITE_TOKEN_CA`, `VITE_TOKEN_TICKER`, `VITE_X_URL`, `VITE_REPO_URL`.

## Deploy (as run for inufly.xyz)

- VPS: code in `/opt/inufly` (user `inufly`), env `/etc/inufly.env`, state `/var/lib/inufly`, unit `deploy/inufly.service`, Caddy block `deploy/Caddyfile` (host `inu-195-226-93-13.sslip.io`).
- Site: Vercel serves only `index.html`; its scripts, the dog model and the neuron labels come from the VPS. On the VPS:

  ```bash
  VITE_SERVER_URL=wss://inu-195-226-93-13.sslip.io/ws VITE_TOKEN_CA=<CA> VITE_TOKEN_TICKER=<TICKER> VITE_X_URL=<post> \
    npx vite build --base=https://inu-195-226-93-13.sslip.io/site/ --outDir dist-remote
  ```

  then deploy `dist-remote/index.html` as the only file of the Vercel project `inufly`.

## Credits

Connectome: FlyEM MaleCNS v1.0 (HHMI Janelia, Cambridge Connectomics Group, Google Research), CC BY 4.0. Simulation and browser export: [fly.ai](https://github.com/alextitonis/fly.ai) (MIT). Dog: Shiba Inu by [Quaternius](https://quaternius.com), CC0.
