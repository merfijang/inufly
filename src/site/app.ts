import { parseMeta, type NeuronMeta } from '../core/connectome';
import { pickDisplayNeurons } from '../shared/display';
import { decodeBits, type AttemptRecord, type ServerMessage, type Stats } from '../shared/protocol';
import { LearningChart } from './chart';
import { brainMetaUrl, connect, serverUrl } from './net';
import { Runner3D } from './runner3d';
import { REGION_COLORS, ROLE_COLORS, Specimen } from './specimen';

const REPO = (import.meta.env.VITE_REPO_URL as string | undefined) || 'https://github.com/merfijang/inufly';
const TOKEN_CA = (import.meta.env.VITE_TOKEN_CA as string | undefined) || null;
const TOKEN_TICKER = (import.meta.env.VITE_TOKEN_TICKER as string | undefined) || null;
const X_URL = (import.meta.env.VITE_X_URL as string | undefined) || null;

const sol = (lamports: number, digits = 4) => (lamports / 1e9).toFixed(digits).replace(/\.?0+$/, '') || '0';
const metres = (m: number) => `${Math.round(m).toLocaleString()} m`;

async function loadMeta() {
  const res = await fetch(brainMetaUrl());
  if (!res.ok || !res.body) throw new Error(`meta.bin: HTTP ${res.status}`);
  let buf = await res.arrayBuffer();
  const b = new Uint8Array(buf, 0, 2);
  if (b[0] === 0x1f && b[1] === 0x8b) buf = await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  return parseMeta(buf);
}

export class SiteApp {
  private readonly $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  private specimen!: Specimen;
  private runner!: Runner3D;
  private chart!: LearningChart;
  private bits = new Uint8Array(0);
  private meta: NeuronMeta | null = null;
  private readoutGroups: string[] = [];
  private stats: Stats | null = null;
  private lastEnd: AttemptRecord | null = null;
  private running = false;
  private idleTimer = 0;
  private readonly flash = [0, 0, 0, 0];

  constructor(root: HTMLElement) {
    root.innerHTML = TEMPLATE;
    this.specimen = new Specimen(this.$<HTMLCanvasElement>('specimen'));
    this.runner = new Runner3D(this.$<HTMLCanvasElement>('runner'));
    this.chart = new LearningChart(this.$<HTMLCanvasElement>('chart'));
    this.token();
    if (X_URL) { const x = this.$<HTMLAnchorElement>('xLink'); x.href = X_URL; x.hidden = false; }
    void loadMeta().then((meta) => { this.meta = meta; this.buildNeurons(); })
      .catch(() => { this.$('specimenNote').textContent = 'The neuron map could not be loaded. Reload the page to try again.'; });
    connect(serverUrl(), {
      message: (m) => this.onMessage(m),
      // a length mismatch means server and site disagree on the neuron map: show nothing rather than wrong neurons
      activity: (bytes) => { if (this.bits.length && bytes.length === Math.ceil(this.bits.length / 8)) this.specimen.activity(decodeBits(bytes, this.bits.length, this.bits)); },
      status: (live) => {
        this.$('pip').classList.toggle('on', live);
        this.$('liveText').textContent = live ? 'Live' : 'Reconnecting to the fly';
      }
    });
  }

  private onMessage(m: ServerMessage) {
    switch (m.type) {
      case 'hello':
        this.readoutGroups = m.readoutGroups; this.buildNeurons();
        this.chart.set(m.history);
        this.lastEnd = m.history.at(-1) ?? null;
        this.running = !!m.current;
        if (m.current) { this.runner.start(m.current); this.attemptLine(m.current.n, m.current.generation, m.current.sample, m.current.pop); }
        this.setStats(m.stats);
        break;
      case 'frame':
        this.runner.frame(m);
        this.hud(m.z, m.p, m.a);
        if (m.a) this.specimen.flap();
        break;
      case 'attempt_start':
        clearTimeout(this.idleTimer);
        this.running = true;
        this.runner.start(m);
        this.attemptLine(m.n, m.generation, m.sample, m.pop);
        this.overlay();
        break;
      case 'attempt_end':
        this.running = false; this.lastEnd = m.record;
        this.runner.end();
        this.chart.add(m.record);
        this.feed(`Attempt ${m.record.n}: ${metres(m.record.metres)} in ${m.record.seconds.toFixed(1)} s. ${m.record.cause}`);
        this.idleTimer = window.setTimeout(() => { if (!this.running) this.runner.idle(); }, 1800);
        this.overlay();
        break;
      case 'fee':
        this.feed(`+${sol(m.lamports)} SOL in fees${m.attemptsAdded ? `, paid for ${m.attemptsAdded} attempt${m.attemptsAdded > 1 ? 's' : ''}` : ''}`, 'fee');
        break;
      case 'stats': {
        const prevGen = this.stats?.generation;
        this.setStats(m.stats);
        if (prevGen !== undefined && m.stats.generation > prevGen) this.feed(`Generation ${prevGen} finished. The fly keeps what ran further and tries again.`, 'gen');
        break;
      }
    }
  }

  /** Distance and the three readouts, lit when the fly acts on one. */
  private hud(z: number, p: number[], a?: string) {
    this.$('hudMetres').textContent = metres(z);
    const idx = ['left', 'right', 'jump', 'roll'].indexOf(a ?? '');
    if (idx >= 0) this.flash[idx] = 1;
    ['pLeft', 'pRight', 'pJump', 'pRoll'].forEach((id, k) => {
      const el = this.$(id);
      el.style.setProperty('--p', String(p[k]));
      el.classList.toggle('fired', this.flash[k] > 0.5);
      this.flash[k] *= 0.9;
    });
  }

  private buildNeurons() {
    if (!this.meta) return;
    const { region, role } = pickDisplayNeurons(this.meta, this.readoutGroups);
    this.specimen.setNeurons(region, role);
    this.bits = new Uint8Array(region.length);
  }

  private setStats(s: Stats) {
    this.stats = s;
    // fees paid in but not run yet: the queued attempts plus the part-paid next one
    const left = s.queue * s.lamportsPerAttempt + s.pendingLamports;
    this.$('bar').style.width = `${Math.min(100, (left / s.lamportsPerAttempt) * 100)}%`;
    this.$('meterText').textContent = `${sol(left)} SOL of fees left to run, ${sol(s.lamportsPerAttempt)} SOL per attempt`;
    this.$('fAttempts').textContent = s.attempts.toLocaleString();
    this.$('fQueue').textContent = s.queue.toLocaleString();
    this.$('fGen').textContent = s.generation.toLocaleString();
    this.$('fBest').textContent = metres(s.bestMetres);
    this.$('fFees').textContent = `${sol(s.totalFeeLamports, 3)} SOL`;
    this.$('price').textContent = sol(s.lamportsPerAttempt);
    const src = this.$('source');
    if (s.feeSource === 'mock') src.textContent = 'Demo mode: fees are simulated until the token launches.';
    else {
      src.textContent = 'Fees are read live from the creator fee vaults on Solana: ';
      s.feeWallets.forEach((w, i) => {
        const a = document.createElement('a');
        a.href = `https://solscan.io/account/${w}`; a.target = '_blank'; a.rel = 'noopener';
        a.textContent = `${w.slice(0, 4)}…${w.slice(-4)}`;
        src.append(...(i ? [', ', a] : [a]));
      });
      if (!s.feeWallets.length) src.append('waiting for the coin to launch');
      src.append('.');
    }
    this.overlay();
  }

  private attemptLine(n: number, gen: number, sample: number, pop: number) {
    this.$('attemptLine').textContent = `Attempt ${n.toLocaleString()} · try ${sample + 1} of ${pop} in generation ${gen}`;
  }

  private overlay() {
    const el = this.$('overlay'), s = this.stats;
    if (this.running || !s) { el.hidden = true; return; }
    el.hidden = false;
    const last = this.lastEnd ? `<p class="last">Last run: ${metres(this.lastEnd.metres)} in ${this.lastEnd.seconds.toFixed(1)} s. ${this.lastEnd.cause}</p>` : '';
    el.innerHTML = s.queue > 0
      ? `${last}<p>The next run is paid for. The fly is working through it now.</p>`
      : `${last}<p>Waiting for fees. The next run starts when ${sol(s.lamportsPerAttempt)} SOL has been collected.</p>`;
  }

  private feed(text: string, kind = '') {
    const li = document.createElement('li');
    li.textContent = text; if (kind) li.className = kind;
    const list = this.$('feed');
    list.prepend(li);
    while (list.children.length > 9) list.lastElementChild!.remove();
  }

  /** Contract address strip: "soon" and a disabled button until VITE_TOKEN_CA is set. */
  private token() {
    if (TOKEN_TICKER) this.$('caLabel').textContent = `Contract address · ${TOKEN_TICKER}`;
    const btn = this.$<HTMLButtonElement>('copy'), label = this.$('copyLabel');
    if (!TOKEN_CA) { btn.disabled = true; btn.title = 'The contract address is published at launch'; return; }
    this.$('caValue').textContent = TOKEN_CA;
    let timer = 0;
    btn.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(TOKEN_CA); label.textContent = 'Copied'; }
      catch { label.textContent = 'Press Ctrl+C'; getSelection()?.selectAllChildren(this.$('caValue')); }
      clearTimeout(timer); timer = window.setTimeout(() => { label.textContent = 'Copy'; }, 2000);
    });
  }
}

const LEGEND = [
  [REGION_COLORS[0], 'Optic lobes'], [REGION_COLORS[2], 'Central brain'], [REGION_COLORS[3], 'Neck connective'],
  [REGION_COLORS[4], 'Nerve cord'], [REGION_COLORS[6], 'Motor neurons'],
  [ROLE_COLORS.input, 'Cells that see the track'], [ROLE_COLORS.readout, 'Cells the moves are read from']
].map(([color, label]) => `<li><i style="background:${color}"></i>${label}</li>`).join('');

const TEMPLATE = `
<header class="top">
  <a class="mark" href="/">InuFly</a>
  <p class="live"><span id="pip" class="pip"></span><span id="liveText">Connecting to the fly</span></p>
  <nav class="links">
    <a class="nav" href="#how">How it works</a>
    <a class="nav" href="#run">Run your own</a>
    <a class="nav" id="xLink" hidden target="_blank" rel="noopener">X</a>
    <a class="nav" href="${REPO}" target="_blank" rel="noopener">GitHub</a>
  </nav>
</header>
<main>
  <section class="hero">
    <div class="intro">
      <p class="eyebrow">male CNS v1.0 · 166,700 neurons · 25,088,107 connections</p>
      <h1>A fly brain <em>runs a dog</em></h1>
      <p class="lede">A real fruit-fly connectome steers a Shiba Inu through the obstacles of Subway Surfers, faster and faster. It only gets a run when trading fees pay for one, and every run teaches it to go a little further.</p>
    </div>
    <div class="stage">
      <figure class="arena">
        <div class="screen">
          <canvas id="runner" aria-label="The dog the fly is steering"></canvas>
          <div class="hud" aria-hidden="true">
            <p class="hud-metres" id="hudMetres">0 m</p>
            <div class="moves">
              <span class="move" id="pLeft"><b>Left</b><i></i></span>
              <span class="move" id="pJump"><b>Jump</b><i></i></span>
              <span class="move" id="pRoll"><b>Roll</b><i></i></span>
              <span class="move" id="pRight"><b>Right</b><i></i></span>
            </div>
          </div>
          <div id="overlay" class="overlay" hidden></div>
        </div>
        <figcaption id="attemptLine">Waiting for the first run</figcaption>
      </figure>
      <figure class="specimen">
        <canvas id="specimen" aria-label="The fly's neurons, lit as they fire"></canvas>
        <figcaption id="specimenNote">Every dot is one real neuron of the fly running the dog, drawn where its part of the nervous system sits. A region glows when it fires more than usual.</figcaption>
        <ul class="legend">${LEGEND}</ul>
      </figure>
    </div>
  </section>

  <section class="ca-strip" aria-label="Contract address">
    <div>
      <p class="ca-label" id="caLabel">Contract address</p>
      <p class="ca-value" id="caValue">soon</p>
    </div>
    <button type="button" id="copy" class="copy"><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="5" width="8.5" height="8.5" rx="1.5"/><path d="M10.5 3.5v-.5A1.5 1.5 0 0 0 9 1.5H3A1.5 1.5 0 0 0 1.5 3v6A1.5 1.5 0 0 0 3 10.5h.5"/></svg><span id="copyLabel">Copy</span></button>
  </section>

  <section class="meter" aria-label="Fees and progress">
    <div class="bar" role="presentation"><i id="bar"></i></div>
    <p id="meterText" class="meter-text">Connecting…</p>
    <dl class="figures">
      <div><dt>Runs</dt><dd id="fAttempts">0</dd></div>
      <div><dt>Paid and waiting</dt><dd id="fQueue">0</dd></div>
      <div><dt>Generation</dt><dd id="fGen">0</dd></div>
      <div><dt>Best run</dt><dd id="fBest">0 m</dd></div>
      <div><dt>Fees collected</dt><dd id="fFees">0 SOL</dd></div>
    </dl>
    <p id="source" class="source"></p>
  </section>

  <section class="learning">
    <div class="curve">
      <h2>How far it gets</h2>
      <p>Each dot is one run, in metres. The line is the average of each generation of ten runs.</p>
      <canvas id="chart" aria-label="Distance per run over time"></canvas>
    </div>
    <div class="latest">
      <h2>Latest</h2>
      <ol id="feed" class="feed"></ol>
    </div>
  </section>

  <section class="how" id="how">
    <h2>What’s actually happening</h2>
    <div class="cols">
      <div>
        <h3>The brain is real</h3>
        <p>The wiring is the <a href="https://male-cns.janelia.org" target="_blank" rel="noopener">FlyEM male CNS connectome</a> (CC BY 4.0): 166,700 neurons and 25 million connections traced from electron-microscope images of one fruit fly. It runs as leaky integrate-and-fire neurons, 50 steps a second. No connection is ever changed.</p>
      </div>
      <div>
        <h3>How it sees and moves</h3>
        <p>The track reaches the fly on its own visual cells: something to jump on LC4, the looming cells that trigger its escape jump; something to roll under on LC6; a train ahead, parked or oncoming, on LPLC1; a blocked lane on the left or right on LPLC2 of that side. Left, right, jump and roll are each read from eight populations deeper in the brain, measured to follow those signals.</p>
      </div>
      <div>
        <h3>How trading teaches it</h3>
        <p>Every <span id="price">0.001</span> SOL of fees buys one run. Each run uses a slightly changed readout of those populations. After ten runs the fly keeps what went further. Thirty-six numbers learn; nothing about the running is scripted.</p>
      </div>
    </div>
    <p class="honest">This is an experiment, not a claim that a fly understands trains. The way the track reaches its eyes and the way a move is read out are designed interfaces. When the dog runs badly, you are watching it run badly.</p>
    <p class="fine">The server shares one CPU core with another fly, so each run is computed first and then shown in real time, a few seconds behind. Dog model: Shiba Inu by Quaternius (CC0).</p>
  </section>

  <section class="run" id="run">
    <h2>Run your own</h2>
    <p class="lede">All of it is open source: the connectome simulation, the game, the fee watcher and this page.</p>
    <ol class="steps">
      <li>
        <h3>Get it running</h3>
        <p>Needs Node 20 or newer. On the first start the server loads the 57 MB connectome and measures which neurons to read the moves from, which takes about a minute. Then it runs on simulated fees.</p>
        <pre><code>git clone ${REPO}.git
cd inufly
npm install
npm run server   <span class="c"># the fly, on :8788</span>
npm run dev      <span class="c"># the site, on :5173</span></code></pre>
      </li>
      <li>
        <h3>Let a token pay for the runs</h3>
        <p>Give the server a pump.fun coin and it finds the coin&rsquo;s creator fee vaults itself, before and after it migrates to PumpSwap.</p>
        <pre><code>FEE_SOURCE=solana \\
FEE_TOKEN=&lt;your coin address&gt; \\
SOL_PER_ATTEMPT=0.001 npm run server</code></pre>
      </li>
    </ol>
    <p class="credit">Built on <a href="https://github.com/alextitonis/fly.ai" target="_blank" rel="noopener">fly.ai</a> (the connectome export and simulation) and <a href="https://github.com/ns2250225/fly-flappy" target="_blank" rel="noopener">fly-flappy</a>.</p>
  </section>
</main>`;
