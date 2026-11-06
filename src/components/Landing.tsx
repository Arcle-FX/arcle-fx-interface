// ============================================================
//  Landing — animated hero screen shown before wallet connect
// ============================================================
import { useEffect, useRef, useCallback } from 'react';
import { showToast } from './Modals';

interface Props {
  className: string;
  style:     React.CSSProperties;
  onOpenApp: (tab?: 'bridge' | 'swap' | 'unified') => void;
}

/* ================================================================
   SUPPORTED NETWORKS: Ethereum · Arbitrum · Base · Arc Network
   ================================================================ */
const NET_COLORS: Record<string, string> = {
  ethereum: '#627EEA',
  arbitrum: '#12AAFF',
  base:     '#0052FF',
  arc:      '#7c5cff',
};

const NET_NAMES: Record<string, string> = {
  ethereum: 'Ethereum',
  arbitrum: 'Arbitrum',
  base:     'Base',
  arc:      'Arc Network',
};

/*
 * Official logo sources.
 * Ethereum / Arbitrum / Base → TrustWallet Assets (GitHub raw CDN)
 * Arc Network → official SVG from Circle website (/public/arc-logo.svg)
 */
const NET_LOGOS: Record<string, string> = {
  ethereum: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/info/logo.png',
  arbitrum: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/arbitrum/info/logo.png',
  base:     'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/base/info/logo.png',
  arc:      '/arc-logo.svg',  // Official Arc Network SVG logo from Circle website
};

/*
 * Arc Network official logo — SVG served directly from Circle website.
 * Source: https://cdn.prod.website-files.com/67116d0daddc92483c812ead/6aa2bfc0ccf0928934d20539_Arc_network%20(1).svg
 * 500×500 viewBox · rounded #1B3158 background · white arch symbol
 * Saved locally as /public/arc-logo.svg.
 */
const ARC_LOGO_URL = '/arc-logo.svg';

/* Keys used in the orbit canvas animation */
const ORBIT_KEYS = ['ethereum', 'arbitrum', 'base', 'arc'] as const;

/* Networks shown in the marquee strip — repeated 3× for seamless loop */
const STRIP_NETS = ['ethereum', 'arbitrum', 'base', 'arc'];

/* Words cycled by the hero rotator */
const ROTATOR_WORDS = ['Arbitrum', 'Base', 'Arc Network', 'Ethereum'];

/* Live transfer card route rotation — 4 supported networks only */
const LIVE_ROUTES_DATA = [
  { from: 'ethereum', to: 'arc',      tok: 'ETH',  v: 1.24  },
  { from: 'base',     to: 'arc',      tok: 'ETH',  v: 0.82  },
  { from: 'arbitrum', to: 'ethereum', tok: 'USDC', v: 500.0 },
  { from: 'ethereum', to: 'base',     tok: 'ETH',  v: 2.15  },
  { from: 'arc',      to: 'arbitrum', tok: 'USDC', v: 1200.0},
];

function fmtAmt(v: number, tok: string) {
  if (tok === 'USDC' || tok === 'EURC') return v.toFixed(2);
  return v.toFixed(4);
}

// ── Draws the Arc Network logo onto a canvas context ─────
// Official SVG: rounded #1B3158 background + white arch symbol (500×500).
// Rendered via drawImage, same as any raster image.
function drawArcLogo(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, r: number,
  img?: HTMLImageElement
) {
  if (img?.complete && img.naturalWidth > 0) {
    /* SVG is square — draw centered; circular clip is applied by the caller */
    const d = r * 2;
    ctx.drawImage(img, cx - r, cy - r, d, d);
  } else {
    /* Fallback — solid dark circle shown while image loads */
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = '#1B3158'; ctx.fill();
  }
}

function initOrbit(cv: HTMLCanvasElement): () => void {
  const ctx = cv.getContext('2d')!;

  const keys = [...ORBIT_KEYS]; // ['ethereum', 'arbitrum', 'base', 'arc']
  let w = 0, h = 0, raf = 0, running = false;
  const t0 = performance.now();
  const packets: { i: number; u: number; sp: number; inbound: boolean; col: string }[] = [];
  let lastSpawn = 0;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* Image cache for all node logos */
  const imgs: Record<string, HTMLImageElement> = {};
  keys.forEach(k => {
    const url = NET_LOGOS[k];
    if (!url) return;
    const im = new Image();
    im.crossOrigin = 'anonymous';
    im.src = url;
    imgs[k] = im;
  });

  /* Center logo */
  const centerImg = new Image();
  centerImg.onload = () => { if (running) frame(performance.now()); };
  centerImg.src = '/center-logo.png';

  function resize() {
    const r   = cv.getBoundingClientRect();
    const dpr = Math.min(devicePixelRatio || 1, 2);
    w = r.width; h = r.height;
    cv.width  = w * dpr; cv.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /* 4 nodes spaced 90° apart — symmetric and clean orbit layout */
  const pos = (i: number, t: number) => {
    const a = t * 0.00008 + (i / keys.length) * Math.PI * 2 - Math.PI / 2;
    return { x: w/2 + Math.cos(a) * w * 0.37, y: h/2 + Math.sin(a) * h * 0.37 };
  };
  const cp  = (p: {x:number;y:number}) => {
    const mx = (p.x + w/2)/2, my = (p.y + h/2)/2;
    const dx = w/2-p.x, dy = h/2-p.y;
    return { x: mx - dy*0.22, y: my + dx*0.22 };
  };
  const qb  = (
    p0: {x:number;y:number}, c: {x:number;y:number},
    p1: {x:number;y:number}, u: number
  ) => ({
    x: (1-u)**2*p0.x + 2*(1-u)*u*c.x + u*u*p1.x,
    y: (1-u)**2*p0.y + 2*(1-u)*u*c.y + u*u*p1.y,
  });
  const spawn = (i: number, inbound = true) =>
    packets.push({ i, u: 0, sp: 0.006 + Math.random()*0.006, inbound,
                   col: NET_COLORS[keys[i]] || '#7c5cff' });

  function frame(now: number) {
    const t = now - t0;
    ctx.clearRect(0, 0, w, h);
    const C = { x: w/2, y: h/2 };

    /* Orbit rings */
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,.06)';
    ctx.setLineDash([2, 6]);
    [0.37, 0.24].forEach(f => {
      ctx.beginPath(); ctx.ellipse(C.x, C.y, w*f, h*f, 0, 0, Math.PI*2); ctx.stroke();
    });
    ctx.restore();

    const P = keys.map((_, i) => pos(i, t));

    /* Connection wires from each node to center */
    P.forEach((p, i) => {
      const c = cp(p);
      const g = ctx.createLinearGradient(p.x, p.y, C.x, C.y);
      g.addColorStop(0, NET_COLORS[keys[i]] + '55');
      g.addColorStop(1, 'rgba(124,92,255,.15)');
      ctx.strokeStyle = g; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(p.x, p.y);
      ctx.quadraticCurveTo(c.x, c.y, C.x, C.y); ctx.stroke();
    });

    /* Transfer packets — animated dots moving along wires */
    if (now - lastSpawn > 520 && packets.length < 12) {
      spawn(Math.floor(Math.random() * keys.length), Math.random() > 0.3);
      lastSpawn = now;
    }
    for (let pi = packets.length - 1; pi >= 0; pi--) {
      const pk = packets[pi];
      pk.u += pk.sp;
      const p = P[pk.i], c = cp(p);
      for (let k = 0; k < 10; k++) {
        const u = pk.u - k*0.014; if (u < 0) break;
        const q = pk.inbound ? qb(p, c, C, u) : qb(C, c, p, u);
        ctx.globalAlpha = (1 - k/10) * 0.9;
        ctx.fillStyle   = k === 0 ? '#fff' : pk.col;
        ctx.beginPath(); ctx.arc(q.x, q.y, k===0 ? 2.6 : 2.2 - k*0.15, 0, Math.PI*2); ctx.fill();
      }
      ctx.globalAlpha = 1;
      if (pk.u >= 1) {
        if (pk.inbound) spawn(Math.floor(Math.random() * keys.length), false);
        packets.splice(pi, 1);
      }
    }

    /* Center pulse ring + glow */
    const pulse = (t % 2400) / 2400;
    ctx.strokeStyle = `rgba(124,92,255,${0.5*(1-pulse)})`; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(C.x, C.y, 38+pulse*40, 0, Math.PI*2); ctx.stroke();
    const cg = ctx.createRadialGradient(C.x, C.y, 0, C.x, C.y, 70);
    cg.addColorStop(0, 'rgba(124,92,255,.45)'); cg.addColorStop(1, 'rgba(124,92,255,0)');
    ctx.fillStyle = cg; ctx.beginPath(); ctx.arc(C.x, C.y, 70, 0, Math.PI*2); ctx.fill();

    /* ── CENTER — logo ── */
    ctx.save();
    ctx.beginPath(); ctx.arc(C.x, C.y, 34, 0, Math.PI * 2); ctx.clip();

    if (centerImg.complete && centerImg.naturalWidth > 0) {
      /*
       * Logo is 1024×486 (landscape) — fit into a square circle.
       * Scaled so the short edge fills the diameter (object-fit: cover logic).
       */
      const r34 = 34;
      const iw = centerImg.naturalWidth, ih = centerImg.naturalHeight;
      const scale = (r34 * 2) / Math.min(iw, ih);
      const dw = iw * scale, dh = ih * scale;
      ctx.drawImage(centerImg, C.x - dw / 2, C.y - dh / 2, dw, dh);
    } else {
      /* Fallback gradient circle shown before image loads */
      const cFill = ctx.createRadialGradient(C.x, C.y, 0, C.x, C.y, 34);
      cFill.addColorStop(0, '#00d4ff'); cFill.addColorStop(1, '#7c5cff');
      ctx.fillStyle = cFill;
      ctx.beginPath(); ctx.arc(C.x, C.y, 34, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();

    /* Outer ring — frames the center logo */
    ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(C.x, C.y, 36, 0, Math.PI * 2); ctx.stroke();

    /* Network node circles + logos + labels */
    ctx.font = '600 12px Inter, sans-serif'; ctx.textAlign = 'center';
    P.forEach((p, i) => {
      const key = keys[i];

      /* Background circle — dark, opaque */
      ctx.fillStyle = 'rgba(7,9,18,.95)';
      ctx.strokeStyle = NET_COLORS[key] + '55';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(p.x, p.y, 26, 0, Math.PI*2);
      ctx.fill(); ctx.stroke();

      /* Outer accent ring — network brand color */
      ctx.strokeStyle = NET_COLORS[key] + '33';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(p.x, p.y, 29, 0, Math.PI*2);
      ctx.stroke();

      if (key === 'arc') {
        /* Arc Network — official SVG logo with circular clip */
        ctx.save();
        ctx.beginPath(); ctx.arc(p.x, p.y, 22, 0, Math.PI*2); ctx.clip();
        drawArcLogo(ctx, p.x, p.y, 22, imgs['arc']);
        ctx.restore();
      } else {
        const im = imgs[key];
        if (im?.complete && im.naturalWidth > 0) {
          /* Circular clip for crisp logo rendering */
          ctx.save();
          ctx.beginPath(); ctx.arc(p.x, p.y, 18, 0, Math.PI*2); ctx.clip();
          ctx.drawImage(im, p.x - 18, p.y - 18, 36, 36);
          ctx.restore();
        } else {
          /* Fallback — colored initial while image loads */
          ctx.fillStyle = NET_COLORS[key];
          ctx.font = 'bold 11px Inter';
          ctx.textBaseline = 'middle';
          ctx.fillText(key.slice(0,3).toUpperCase(), p.x, p.y);
          ctx.textBaseline = 'alphabetic';
          ctx.font = '600 12px Inter, sans-serif';
        }
      }

      /* Network name label below each node */
      ctx.fillStyle = 'rgba(183,191,208,.85)';
      ctx.font = '600 11px Inter, sans-serif';
      ctx.fillText(NET_NAMES[key], p.x, p.y + 46);
      ctx.font = '600 12px Inter, sans-serif';
    });

    if (running && !reduce) raf = requestAnimationFrame(frame);
  }

  function start() { if (running) return; running = true; resize(); raf = requestAnimationFrame(frame); }
  function stop()  { running = false; cancelAnimationFrame(raf); }

  window.addEventListener('resize', () => { if (running) resize(); });
  const obs = new IntersectionObserver(([e]) => { if (e.isIntersecting) start(); else stop(); });
  obs.observe(cv);
  if (reduce) { resize(); frame(performance.now()); }

  return () => { stop(); obs.disconnect(); };
}

/* ── Landing Component ── */
export default function Landing(
  { className, style, onOpenApp }: Props
) {
  const canvasRef  = useRef<HTMLCanvasElement>(null);
  const barRef     = useRef<HTMLSpanElement>(null);
  const amtRef     = useRef<HTMLDivElement>(null);
  const statusRef  = useRef<HTMLSpanElement>(null);
  const timeRef    = useRef<HTMLSpanElement>(null);
  const routeRef   = useRef<HTMLDivElement>(null);
  const volRef     = useRef<HTMLDivElement>(null);
  const rotatorRef = useRef<HTMLSpanElement>(null);

  /* canvas orbit */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    return initOrbit(canvas);
  }, []);

  /* rotator */
  useEffect(() => {
    let idx = 0;
    const el = rotatorRef.current;
    if (!el) return;

    /*
     * Measure the paragraph height for every word before the interval starts.
     * Lock min-height to the tallest result so shorter words (e.g. "Base")
     * never cause the surrounding layout to reflow.
     */
    const para = el.closest('p') as HTMLElement | null;
    if (para) {
      let maxH = 0;
      ROTATOR_WORDS.forEach(word => {
        el.textContent = word;
        const h = para.getBoundingClientRect().height;
        if (h > maxH) maxH = h;
      });
      para.style.minHeight = maxH + 'px';
      el.textContent = ROTATOR_WORDS[0];
      idx = 0;
    }

    const iv = setInterval(() => {
      el.classList.add('rot-out');
      setTimeout(() => {
        idx = (idx + 1) % ROTATOR_WORDS.length;
        el.textContent = ROTATOR_WORDS[idx];
        el.classList.remove('rot-out');
        el.classList.add('rot-pre');
        void el.offsetWidth;
        el.classList.remove('rot-pre');
      }, 450);
    }, 2600);
    return () => clearInterval(iv);
  }, []);

  /* Live transfer card — interval-driven progress simulation */
  useEffect(() => {
    let p = 0, t = 0, routeIdx = 0;

    function next() {
      const route = LIVE_ROUTES_DATA[routeIdx % LIVE_ROUTES_DATA.length];
      routeIdx++;
      p = 0; t = 0;
      if (routeRef.current) {
        // Build child nodes via DOM API — no innerHTML, no XSS surface
        const from     = route.from;
        const to       = route.to;
        const fragment = document.createDocumentFragment();

        const mkImg = (key: string) => {
          const img = document.createElement('img');
          img.src    = NET_LOGOS[key] ?? '';
          img.alt    = NET_NAMES[key] ?? key;
          img.style.cssText = 'width:22px;height:22px;border-radius:50%;object-fit:cover;';
          return img;
        };
        const mkSpan = (text: string) => {
          const s = document.createElement('span');
          s.style.cssText = 'font-weight:600;font-size:.92rem;';
          s.textContent   = text;
          return s;
        };
        const mkArrow = () => {
          const i = document.createElement('i');
          i.className       = 'ph-bold ph-arrow-right';
          i.style.cssText   = 'color:rgba(255,255,255,.35);font-size:.8rem;';
          return i;
        };

        fragment.append(mkImg(from), mkSpan(NET_NAMES[from] ?? from), mkArrow(), mkImg(to), mkSpan(NET_NAMES[to] ?? to));
        routeRef.current.replaceChildren(fragment);
      }
      if (amtRef.current)    amtRef.current.textContent    = `${fmtAmt(route.v, route.tok)} ${route.tok}`;
      if (statusRef.current) { statusRef.current.textContent = 'Relaying…'; statusRef.current.style.color = ''; }
      if (barRef.current)    barRef.current.style.width     = '0%';
    }

    const iv = setInterval(() => {
      if (p >= 100) { if (t > 13.5) next(); else t += 0.1; return; }
      p = Math.min(100, p + Math.random() * 3.2 + 0.4);
      t += 0.1;
      if (barRef.current)  barRef.current.style.width  = p + '%';
      if (timeRef.current) timeRef.current.textContent = t.toFixed(1) + 's';
      if (p >= 100 && statusRef.current) {
        statusRef.current.textContent = '✓ Delivered';
        statusRef.current.style.color = '#2ee6a6';
      }
    }, 100);

    const volIv = setInterval(() => {
      const v = 48.2 + (Math.random() - 0.3) * 0.4;
      if (volRef.current) volRef.current.textContent = '$' + v.toFixed(1) + 'M';
    }, 3000);

    next();
    return () => { clearInterval(iv); clearInterval(volIv); };
  }, []);

  return (
    <div id="landing-view" className={className} style={style}>

      {/* ── HERO ── */}
      <section className="hero-section">
        <div className="hero-inner">

          {/* Left — text content */}
          <div className="hero-left">

            {/* Announce pill */}
            <div className="hero-announce">
              <span className="hero-announce-new">NEW</span>
              Arcle FX v2 is now live
              <i className="ph-bold ph-arrow-right" style={{ fontSize: '0.8rem', color: '#565e70' }}></i>
            </div>

            {/* Heading */}
            <h1 className="hero-h1">
              <span className="hero-line">One bridge.</span>
              <span className="hero-line hero-grad">Every chain.</span>
            </h1>

            {/* Subtitle + rotating network word */}
            <p className="hero-sub">
              Move assets to{' '}
              <span className="hero-rotator-wrap">
                <span ref={rotatorRef} className="hero-rotator-word">Arbitrum</span>
              </span>
              {' '}in <strong>~12 seconds</strong>. Arcle FX unifies
              liquidity across networks into one fast, audited, non-custodial layer.
            </p>

            {/* CTA buttons */}
            <div className="hero-ctas">
              <button className="hero-btn-primary" onClick={() => onOpenApp('bridge')}>
                Bridge Now <i className="ph-bold ph-arrow-right"></i>
              </button>
              <a className="hero-btn-ghost" href="https://docs.arclefx.com" target="_blank" rel="noopener noreferrer">
                <i className="ph ph-book-open"></i> View Docs
              </a>
            </div>

            {/* Trust badges */}
            <div className="hero-trust">
              <span><i className="ph-fill ph-lock-key"></i> Non-custodial</span>
              <span><i className="ph-fill ph-circle-notch"></i> Powered by Circle</span>
              <span><i className="ph-fill ph-globe"></i> Mainnet Live</span>
            </div>
          </div>

          {/* Right — canvas + floating cards */}
          <div className="hero-right">
            <canvas ref={canvasRef} className="hero-canvas"
              aria-label="Animated visualization of transfers between networks"
              role="img" />

            {/* Live Transfer card — bottom left */}
            <div className="live-card live-card-left" aria-hidden="true">
              <div className="lc-top">
                <span>Live transfer</span>
                <span className="lc-live-badge">
                  <span className="lc-beacon"></span>Live
                </span>
              </div>
              <div ref={routeRef} className="lc-route"></div>
              <div ref={amtRef}   className="lc-amount num">0 ETH</div>
              <div className="lc-bar-track">
                <span ref={barRef} className="lc-bar-fill"></span>
              </div>
              <div className="lc-foot">
                <span ref={statusRef}>Relaying…</span>
                <span ref={timeRef} className="lc-time num">0.0s</span>
              </div>
            </div>

            {/* 24h Volume card — top right */}
            <div className="live-card live-card-right" aria-hidden="true">
              <div className="lc-top"><span>24h volume</span></div>
              <div ref={volRef} className="lc-vol num">$48.2M</div>
              <div className="lc-delta">
                <i className="ph-bold ph-trend-up"></i> +12.4%
              </div>
            </div>
          </div>

        </div>
      </section>

      {/* ── MARQUEE strip — 4 supported networks ── */}
      <div className="marquee-container">
        <div className="marquee-content">
          {Array.from({ length: 6 }, () => STRIP_NETS).flat().map((k, i) => (
            <div className="marquee-item" key={i}>
              <span className="marquee-logo-wrap"
                style={{ background: NET_COLORS[k] + '18', borderColor: NET_COLORS[k] + '40' }}>
              {k === 'arc'
                ? <img src={ARC_LOGO_URL} alt="Arc Network"
                    style={{ width: 24, height: 24, borderRadius: '50%', objectFit: 'cover', display: 'block' }} />
                : <img src={NET_LOGOS[k]} alt={NET_NAMES[k]}
                    style={{ width: 24, height: 24, borderRadius: '50%', objectFit: 'cover', display: 'block' }} />
              }
              </span>
              <span className="marquee-label">{NET_NAMES[k]}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── HOW IT WORKS — steps section (Arc Test 7 design) ── */}
      <div className="how-section" id="features">
        <div className="landing-container">

          {/* Section header */}
          <div className="s-head s-head--center">
            <span className="how-kicker">How it works</span>
            <h2 className="how-h2">Three steps. Zero friction.</h2>
            <p className="how-sub">No wrapped assets, no manual claims, no waiting periods.</p>
          </div>

          {/* Steps grid */}
          <div className="steps-grid">

            <div className="step-card"
              onMouseMove={e => {
                const r = e.currentTarget.getBoundingClientRect();
                e.currentTarget.style.setProperty('--mx', (e.clientX - r.left) + 'px');
                e.currentTarget.style.setProperty('--my', (e.clientY - r.top)  + 'px');
              }}
            >
              <div className="step-num">
                <span>01</span>
                <div className="step-line"></div>
              </div>
              <div className="step-icon">
                <i className="ph ph-wallet"></i>
              </div>
              <h3 className="step-title">Connect</h3>
              <p className="step-desc">Link MetaMask, Coinbase Wallet or any WalletConnect wallet in a single click.</p>
            </div>

            <div className="step-card"
              onMouseMove={e => {
                const r = e.currentTarget.getBoundingClientRect();
                e.currentTarget.style.setProperty('--mx', (e.clientX - r.left) + 'px');
                e.currentTarget.style.setProperty('--my', (e.clientY - r.top)  + 'px');
              }}
            >
              <div className="step-num">
                <span>02</span>
                <div className="step-line"></div>
              </div>
              <div className="step-icon">
                <i className="ph ph-path"></i>
              </div>
              <h3 className="step-title">Choose a route</h3>
              <p className="step-desc">Pick Express for speed or Economy for the lowest fee. We handle the routing.</p>
            </div>

            <div className="step-card"
              onMouseMove={e => {
                const r = e.currentTarget.getBoundingClientRect();
                e.currentTarget.style.setProperty('--mx', (e.clientX - r.left) + 'px');
                e.currentTarget.style.setProperty('--my', (e.clientY - r.top)  + 'px');
              }}
            >
              <div className="step-num">
                <span>03</span>
                <div className="step-line"></div>
              </div>
              <div className="step-icon">
                <i className="ph ph-check-circle"></i>
              </div>
              <h3 className="step-title">Receive</h3>
              <p className="step-desc">Sign once. Native assets land in your wallet on the destination chain.</p>
            </div>

          </div>
        </div>
      </div>

      {/* ── FOOTER (Arc Test 7 design) ── */}
      <footer className="site-footer">
        {/* Inner container — content centered, border spans full width */}
        <div className="f-inner">

          {/* Top row: brand + nav columns */}
          <div className="f-top">

            {/* Brand + tagline + newsletter */}
            <div className="f-brand">
              <div className="f-brand-name">
                <img src="/center-logo.png" alt="Arcle FX" className="f-logo-img" />
                <span>Arcle FX</span>
              </div>
              <p>Cross-Chain FX Protocol — Fast, secure and non-custodial.</p>
              <form
                className="f-news"
                onSubmit={e => {
                  e.preventDefault();
                  const form = e.target as HTMLFormElement;
                  const email = (form.elements.namedItem('f-email') as HTMLInputElement).value;
                  showToast('success', 'Subscribed', email);
                  form.reset();
                }}
              >
                <label htmlFor="f-email" className="sr-only">Email address</label>
                <input
                  id="f-email"
                  type="email"
                  placeholder="you@email.com"
                  required
                />
                <button type="submit" className="f-sub-btn">Subscribe</button>
              </form>
            </div>

            {/* Product links */}
            <div className="f-col">
              <h4>Product</h4>
              <a href="#" onClick={e => { e.preventDefault(); onOpenApp('bridge'); }}>Bridge</a>
              <a href="#" onClick={e => { e.preventDefault(); onOpenApp('swap'); }}>Swap</a>
              <a href="#" onClick={e => { e.preventDefault(); onOpenApp('unified'); }}>Unified</a>
            </div>

            {/* Developer links */}
            <div className="f-col">
              <h4>Developers</h4>
              <a href="https://docs.arclefx.com" target="_blank" rel="noopener noreferrer">Documentation</a>
              <a href="https://www.arc.io/app-kits" target="_blank" rel="noopener noreferrer">SDK</a>
              <a href="https://github.com/Arcle-FX" target="_blank" rel="noopener noreferrer">GitHub</a>
            </div>

            {/* Company links */}
            <div className="f-col">
              <h4>Company</h4>
              <a href="/blog/">Blog</a>
              <a href="/legal/">Terms</a>
              <a href="/legal/?tab=privacy">Privacy</a>
            </div>

          </div>

          {/* Bottom bar */}
          <div className="f-bot">
            <span>© 2026 Arcle FX. All rights reserved.</span>
            <span className="f-status-pill">All systems operational</span>
            <div className="f-socials">
              <a href="https://x.com/ArcleFX" target="_blank" rel="noopener noreferrer" aria-label="X / Twitter"><i className="ph-fill ph-x-logo"></i></a>
              <a href="#" aria-label="Discord"><i className="ph-fill ph-discord-logo"></i></a>
              <a href="https://github.com/Arcle-FX" target="_blank" rel="noopener noreferrer" aria-label="GitHub"><i className="ph-fill ph-github-logo"></i></a>
            </div>
          </div>

        </div>{/* /f-inner */}

        {/* Giant decorative wordmark — spans full footer width */}
        <div className="f-wordmark" aria-hidden="true">Arcle FX</div>
      </footer>
    </div>
  );
}
