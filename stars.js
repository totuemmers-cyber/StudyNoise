// Ambient background: a sparse twinkling starfield with the occasional
// shooting star drifting from the upper-right toward the lower-left.
//
// Kept deliberately subtle and infrequent so it reads as gentle background
// motion rather than a busy meteor shower. Honours prefers-reduced-motion by
// rendering a single static field with no animation.

(function () {
  "use strict";

  const canvas = document.getElementById("stars");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const reduceMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)"
  ).matches;

  let w = 0;
  let h = 0;
  let dpr = 1;
  let twinkles = [];
  const shooting = [];
  let nextSpawn = 1.0; // seconds until the first streak
  let last = 0;

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = canvas.width = Math.floor(window.innerWidth * dpr);
    h = canvas.height = Math.floor(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + "px";
    canvas.style.height = window.innerHeight + "px";
    seedTwinkles();
  }

  function seedTwinkles() {
    const count = Math.round((w * h) / (44000 * dpr));
    twinkles = [];
    for (let i = 0; i < count; i++) {
      twinkles.push({
        x: Math.random() * w,
        y: Math.random() * h,
        r: (Math.random() * 1.1 + 0.3) * dpr,
        base: Math.random() * 0.3 + 0.1, // resting brightness
        phase: Math.random() * Math.PI * 2,
        speed: Math.random() * 0.8 + 0.3,
      });
    }
  }

  function spawnShooting() {
    const speed = (Math.random() * 120 + 160) * dpr; // px per second
    const angle = ((Math.random() * 12 + 28) * Math.PI) / 180; // below horizontal
    shooting.push({
      x: (Math.random() * 0.6 + 0.45) * w, // start in the right portion
      y: (Math.random() * 0.35 - 0.1) * h, // start near the top
      vx: -Math.cos(angle) * speed, // travel left...
      vy: Math.sin(angle) * speed, // ...and down
      len: (Math.random() * 60 + 60) * dpr, // tail length
      life: 0,
      ttl: Math.random() * 1.2 + 1.4, // seconds
    });
  }

  function drawTwinkle(s, alpha) {
    ctx.globalAlpha = Math.max(0, alpha);
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.fillStyle = "#dfe4ff";
    ctx.fill();
  }

  function frame(t) {
    const dt = Math.min((t - last) / 1000 || 0, 0.05);
    last = t;
    ctx.clearRect(0, 0, w, h);

    for (const s of twinkles) {
      const a = s.base + Math.sin((t / 1000) * s.speed + s.phase) * s.base * 0.6;
      drawTwinkle(s, a);
    }
    ctx.globalAlpha = 1;

    nextSpawn -= dt;
    if (nextSpawn <= 0) {
      spawnShooting();
      nextSpawn = Math.random() * 3 + 2.2; // 2.2 - 5.2s between streaks
    }

    for (let i = shooting.length - 1; i >= 0; i--) {
      const m = shooting[i];
      m.life += dt;
      m.x += m.vx * dt;
      m.y += m.vy * dt;

      const ratio = m.life / m.ttl;
      if (ratio >= 1 || m.x < -m.len || m.y > h + m.len) {
        shooting.splice(i, 1);
        continue;
      }

      const alpha = Math.sin(ratio * Math.PI) * 0.6; // ease in and out
      const norm = Math.hypot(m.vx, m.vy) || 1;
      const tx = m.x - (m.vx / norm) * m.len;
      const ty = m.y - (m.vy / norm) * m.len;

      const grad = ctx.createLinearGradient(m.x, m.y, tx, ty);
      grad.addColorStop(0, `rgba(255, 255, 255, ${alpha})`);
      grad.addColorStop(0.4, `rgba(180, 200, 255, ${alpha * 0.5})`);
      grad.addColorStop(1, "rgba(180, 200, 255, 0)");
      ctx.strokeStyle = grad;
      ctx.lineWidth = 1.4 * dpr;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(m.x, m.y);
      ctx.lineTo(tx, ty);
      ctx.stroke();

      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.arc(m.x, m.y, 1.4 * dpr, 0, Math.PI * 2);
      ctx.fillStyle = "#ffffff";
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    requestAnimationFrame(frame);
  }

  function drawStatic() {
    ctx.clearRect(0, 0, w, h);
    for (const s of twinkles) drawTwinkle(s, s.base);
    ctx.globalAlpha = 1;
  }

  window.addEventListener("resize", () => {
    resize();
    if (reduceMotion) drawStatic();
  });

  resize();
  if (reduceMotion) {
    drawStatic();
  } else {
    requestAnimationFrame(frame);
  }
})();
