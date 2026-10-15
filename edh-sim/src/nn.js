// A small neural network (multilayer perceptron) written out by hand so it runs the same in node
// (training) and in the browser (playing). Inputs are a dense feature vector plus a few "sparse"
// inputs that are just on/off (which card this is, which cards are in hand), so the first layer
// only touches the weights of the cards that are actually present.
(function (root) {
  'use strict';

  function rng(seed) {
    let s = seed >>> 0 || 1;
    return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  }

  class MLP {
    // nDense dense inputs, nSparse sparse (one-hot) inputs, hidden layer sizes, one sigmoid output
    constructor(nDense, nSparse, hidden = [48, 24], seed = 1) {
      this.nDense = nDense; this.nSparse = nSparse; this.hidden = hidden;
      const R = rng(seed);
      const gauss = () => { let u = 0, v = 0; while (!u) u = R(); while (!v) v = R(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
      const sizes = [nDense + nSparse, ...hidden, 1];
      this.W = []; this.b = [];
      for (let l = 0; l < sizes.length - 1; l++) {
        const nIn = sizes[l], nOut = sizes[l + 1];
        const w = new Float32Array(nIn * nOut);
        const sd = Math.sqrt(2 / (l === 0 ? nDense + 4 : nIn));
        for (let i = 0; i < w.length; i++) w[i] = gauss() * sd;
        this.W.push(w); this.b.push(new Float32Array(nOut));
      }
      this.sizes = sizes;
    }

    // dense: array of numbers (length nDense); sparse: array of indices into the sparse inputs
    forward(dense, sparse, keep) {
      const acts = [];
      let x = null;
      for (let l = 0; l < this.W.length; l++) {
        const nIn = this.sizes[l], nOut = this.sizes[l + 1], W = this.W[l];
        const out = new Float32Array(nOut);
        out.set(this.b[l]);
        if (l === 0) {
          // weights are stored input-major: W[i * nOut + j]
          for (let i = 0; i < this.nDense; i++) { const v = dense[i]; if (!v) continue; const o = i * nOut; for (let j = 0; j < nOut; j++) out[j] += v * W[o + j]; }
          for (const k of sparse) { const o = (this.nDense + k) * nOut; for (let j = 0; j < nOut; j++) out[j] += W[o + j]; }
        } else {
          for (let i = 0; i < nIn; i++) { const v = x[i]; if (!v) continue; const o = i * nOut; for (let j = 0; j < nOut; j++) out[j] += v * W[o + j]; }
        }
        if (l < this.W.length - 1) for (let j = 0; j < nOut; j++) if (out[j] < 0) out[j] *= 0.01; // leaky ReLU
        if (keep) acts.push(out);
        x = out;
      }
      const z = x[0];
      const p = 1 / (1 + Math.exp(-z));
      if (keep) return { p, acts };
      return p;
    }

    // One pass of Adam over a batch of samples { d: dense, s: sparse, y: 0..1, w: weight }
    trainBatch(batch, lr = 0.002, l2 = 1e-5) {
      if (!this.m) { this.m = this.W.map((w) => new Float32Array(w.length)); this.v = this.W.map((w) => new Float32Array(w.length)); this.mb = this.b.map((b) => new Float32Array(b.length)); this.vb = this.b.map((b) => new Float32Array(b.length)); this.t = 0; }
      const gW = this.W.map((w) => new Float32Array(w.length)), gb = this.b.map((b) => new Float32Array(b.length));
      const touched = new Set();
      let loss = 0;
      for (const smp of batch) {
        const { p, acts } = this.forward(smp.d, smp.s, true);
        const y = smp.y, wt = smp.w ?? 1;
        loss += -wt * (y * Math.log(p + 1e-7) + (1 - y) * Math.log(1 - p + 1e-7));
        let delta = new Float32Array([(p - y) * wt]);
        for (let l = this.W.length - 1; l >= 0; l--) {
          const nIn = this.sizes[l], nOut = this.sizes[l + 1], W = this.W[l], G = gW[l];
          for (let j = 0; j < nOut; j++) gb[l][j] += delta[j];
          if (l === 0) {
            for (let i = 0; i < this.nDense; i++) { const v = smp.d[i]; if (!v) continue; const o = i * nOut; for (let j = 0; j < nOut; j++) G[o + j] += v * delta[j]; }
            for (const k of smp.s) { const o = (this.nDense + k) * nOut; touched.add(k); for (let j = 0; j < nOut; j++) G[o + j] += delta[j]; }
          } else {
            const xin = acts[l - 1];
            const back = new Float32Array(nIn);
            for (let i = 0; i < nIn; i++) {
              const o = i * nOut; let s = 0;
              for (let j = 0; j < nOut; j++) { G[o + j] += xin[i] * delta[j]; s += W[o + j] * delta[j]; }
              back[i] = s * (xin[i] > 0 ? 1 : 0.01);
            }
            delta = back;
          }
        }
      }
      // Adam update (dense part of layer 0 and all other layers; sparse rows only where used)
      this.t++;
      const b1 = 0.9, b2 = 0.999, eps = 1e-8, n = batch.length;
      const c1 = 1 - Math.pow(b1, this.t), c2 = 1 - Math.pow(b2, this.t);
      const upd = (P, M, V, G, i) => { const g = G[i] / n + l2 * P[i]; M[i] = b1 * M[i] + (1 - b1) * g; V[i] = b2 * V[i] + (1 - b2) * g * g; P[i] -= lr * (M[i] / c1) / (Math.sqrt(V[i] / c2) + eps); };
      for (let l = 0; l < this.W.length; l++) {
        const P = this.W[l], M = this.m[l], V = this.v[l], G = gW[l], nOut = this.sizes[l + 1];
        if (l === 0) {
          for (let i = 0; i < this.nDense * nOut; i++) upd(P, M, V, G, i);
          for (const k of touched) { const o = (this.nDense + k) * nOut; for (let j = 0; j < nOut; j++) upd(P, M, V, G, o + j); }
        } else for (let i = 0; i < P.length; i++) upd(P, M, V, G, i);
        for (let j = 0; j < this.b[l].length; j++) upd(this.b[l], this.mb[l], this.vb[l], gb[l], j);
      }
      return loss / n;
    }

    toJSON() {
      const q = (a) => Array.from(a, (x) => Math.round(x * 1e4) / 1e4);
      return { nDense: this.nDense, nSparse: this.nSparse, hidden: this.hidden, W: this.W.map(q), b: this.b.map(q) };
    }
    static fromJSON(j) {
      const m = new MLP(j.nDense, j.nSparse, j.hidden, 1);
      m.W = j.W.map((w) => Float32Array.from(w)); m.b = j.b.map((b) => Float32Array.from(b));
      return m;
    }
  }

  const API = { MLP, rng };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else root.PodNN = API;
})(typeof window !== 'undefined' ? window : globalThis);
