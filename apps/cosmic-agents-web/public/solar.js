/* =========================================================
   COSMIC SOLAR SYSTEM — shared component factory
   -----------------------------------------------------------
   Used by both the landing hero (ambient mode — no speaker
   switching, just orbital motion) and the /demo mission view
   (live mode — driven by WebSocket events).

   Global export: window.createSolarSystem(containerEl, opts)
   Returns an instance with:
     - setActivePlanet(name)     ← glow the agent that's speaking
     - drawTransfer(from, to)    ← comet trail from prev → next
     - destroy()                 ← tear down DOM + listeners
     - setStatus(text)            ← write to graph-status element, if any

   The factory is intentionally DOM-only and stateless beyond
   the instance it returns, so both pages can instantiate it
   without colliding.
   ========================================================= */

(function () {
  "use strict";

  const PLANET_PALETTE = [
    { h1: "#a78bfa", h2: "#22d3ee" },
    { h1: "#22d3ee", h2: "#34d399" },
    { h1: "#f472b6", h2: "#a78bfa" },
    { h1: "#fbbf24", h2: "#f472b6" },
    { h1: "#34d399", h2: "#22d3ee" },
    { h1: "#7c3aed", h2: "#f472b6" },
  ];

  function createSolarSystem(container, options) {
    if (!container) {
      throw new Error("createSolarSystem: container element is required");
    }
    const opts = options || {};
    const mode = opts.mode || "live"; // "ambient" | "live"
    const statusEl = opts.statusEl || null;

    // Instance-scoped state (so two instances don't share DOM refs)
    const graphNodes = new Map(); // agentName → element holding the planet body (or sun-core for Leader)
    let graphLeaderName = null;
    let sunCoreEl = null;
    let graphSvg = null;
    let prevSpeaker = null;

    // Make sure the container has the solar-system class (pages may
    // give it a different initial id and forget the class).
    if (!container.classList.contains("solar-system")) {
      container.classList.add("solar-system");
    }

    // Ensure the SVG comet-trail layer exists.
    graphSvg = container.querySelector(".graph-lines");
    if (!graphSvg) {
      graphSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      graphSvg.classList.add("graph-lines");
      graphSvg.setAttribute("aria-hidden", "true");
      container.appendChild(graphSvg);
    } else {
      graphSvg.innerHTML = "";
    }

    // Ensure the sun-core exists (hidden until a leader is provided).
    sunCoreEl = container.querySelector(".sun-core");
    if (!sunCoreEl) {
      sunCoreEl = document.createElement("div");
      sunCoreEl.className = "sun-core";
      sunCoreEl.setAttribute("data-hidden", "1");
      container.appendChild(sunCoreEl);
    } else {
      sunCoreEl.setAttribute("data-hidden", "1");
      sunCoreEl.classList.remove("active");
      sunCoreEl.removeAttribute("data-name");
    }

    function clearOrbitChildren() {
      Array.from(container.children).forEach((child) => {
        if (child === graphSvg) return;
        if (child === sunCoreEl) return;
        child.remove();
      });
    }

    function layout(leader, agents) {
      clearOrbitChildren();
      graphNodes.clear();
      graphLeaderName = leader ? leader.name : null;

      if (leader && sunCoreEl) {
        sunCoreEl.removeAttribute("data-hidden");
        sunCoreEl.setAttribute("data-name", String(leader.name || "Leader").replace(/_/g, " "));
        sunCoreEl.dataset.agent = leader.name;
        graphNodes.set(leader.name, sunCoreEl);
      }

      const list = Array.isArray(agents) ? agents : [];
      const stageRect = container.getBoundingClientRect();
      const usable = Math.min(stageRect.width || 440, stageRect.height || 440);
      // Outer orbit must stay at least 60px from the container edge so
      // planet labels don't clip against the panel border.
      const maxRadius = Math.max(120, usable / 2 - 60);
      const baseRadius = Math.max(96, usable * 0.22);
      const rawStep = (usable * 0.4 - baseRadius) / Math.max(list.length - 1, 1);
      const step = Math.max(28, rawStep);

      list.forEach((agent, i) => {
        const candidate = baseRadius + i * step;
        const radius = Math.min(candidate, maxRadius);
        const diameter = radius * 2;
        const duration = 20 + (i * 4.5) % 28; // 20..48s
        const initialOffset = (i * 137.5) % 360; // golden-angle spread
        const palette = PLANET_PALETTE[i % PLANET_PALETTE.length];

        const orbit = document.createElement("div");
        orbit.className = "orbit";
        orbit.style.width = diameter + "px";
        orbit.style.height = diameter + "px";
        orbit.style.animationDuration = duration + "s";
        orbit.style.animationDelay = `-${(duration * initialOffset) / 360}s`;

        const anchor = document.createElement("div");
        anchor.className = "planet-anchor";
        anchor.style.animationDuration = duration + "s";
        anchor.style.animationDelay = `-${(duration * initialOffset) / 360}s`;

        const planet = document.createElement("div");
        planet.className = "planet";
        planet.dataset.agent = agent.name;

        const body = document.createElement("div");
        body.className = "planet-body";
        body.style.setProperty("--planet-hue-1", palette.h1);
        body.style.setProperty("--planet-hue-2", palette.h2);

        const label = document.createElement("div");
        label.className = "planet-label";
        label.textContent = String(agent.name || "").replace(/_/g, " ");

        planet.appendChild(body);
        planet.appendChild(label);
        anchor.appendChild(planet);
        orbit.appendChild(anchor);
        container.appendChild(orbit);

        graphNodes.set(agent.name, planet);
      });

      if (statusEl) {
        const total = (leader ? 1 : 0) + list.length;
        statusEl.textContent = `${total} bodies in orbit`;
      }
    }

    function setActivePlanet(name) {
      container.querySelectorAll(".planet").forEach((p) => {
        p.classList.toggle("active", p.dataset.agent === name);
      });
      if (sunCoreEl) {
        sunCoreEl.classList.toggle("active", name === graphLeaderName);
      }
    }

    function getOrbitPoint(el, stageRect) {
      const target =
        el && el.classList && el.classList.contains("planet")
          ? el.querySelector(".planet-body") || el
          : el;
      const r = target.getBoundingClientRect();
      return {
        x: r.left - stageRect.left + r.width / 2,
        y: r.top - stageRect.top + r.height / 2,
      };
    }

    function drawTransfer(fromName, toName) {
      if (!graphSvg || !fromName || !toName || fromName === toName) return;
      const fromEl = graphNodes.get(fromName);
      const toEl = graphNodes.get(toName);
      if (!fromEl || !toEl) return;

      const stageRect = container.getBoundingClientRect();
      if (!stageRect.width) return;

      graphSvg.setAttribute(
        "viewBox",
        "0 0 " + stageRect.width + " " + stageRect.height
      );

      const isLeader = fromName === graphLeaderName;

      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("data-leader", String(isLeader));
      path.classList.add("graph-arrow");
      graphSvg.appendChild(path);

      const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      dot.setAttribute("r", "4.5");
      dot.setAttribute("data-leader", String(isLeader));
      dot.classList.add("graph-dot");
      graphSvg.appendChild(dot);

      let t0 = null;
      const dur = 780;

      function easeInOut(p) {
        return p < 0.5 ? 2 * p * p : -1 + (4 - 2 * p) * p;
      }

      function buildPath() {
        // Recompute endpoints on every frame so the comet tracks the
        // currently-orbiting planets even while they rotate.
        const from = getOrbitPoint(fromEl, stageRect);
        const to = getOrbitPoint(toEl, stageRect);
        const mx = (from.x + to.x) / 2;
        const my = (from.y + to.y) / 2;
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const cpx = mx - dy * 0.28;
        const cpy = my + dx * 0.28;
        path.setAttribute(
          "d",
          `M ${from.x} ${from.y} Q ${cpx} ${cpy} ${to.x} ${to.y}`
        );
      }

      function tick(ts) {
        if (!t0) t0 = ts;
        const raw = Math.min((ts - t0) / dur, 1);
        const p = easeInOut(raw);

        buildPath();
        const len = path.getTotalLength();
        if (!len) {
          path.remove();
          dot.remove();
          return;
        }
        path.style.strokeDasharray = len;
        path.style.strokeDashoffset = len * (1 - p);

        const pt = path.getPointAtLength(len * p);
        dot.setAttribute("cx", pt.x);
        dot.setAttribute("cy", pt.y);

        if (raw < 1) {
          requestAnimationFrame(tick);
        } else {
          const receiving =
            toEl.classList && toEl.classList.contains("planet") ? toEl : null;
          if (receiving) {
            receiving.classList.add("receiving");
            setTimeout(() => receiving.classList.remove("receiving"), 600);
          }
          setTimeout(() => {
            path.style.transition = "opacity 0.45s ease";
            dot.style.transition = "opacity 0.45s ease";
            path.style.opacity = "0";
            dot.style.opacity = "0";
            setTimeout(() => {
              path.remove();
              dot.remove();
            }, 450);
          }, 700);
        }
      }

      requestAnimationFrame(tick);
    }

    // Speaker update: handles prev → next comet + glow swap.
    // In ambient mode we still want the glow and trail but no
    // external driver calls it — the instance exposes the same
    // API so the caller can decide.
    function setSpeaker(name) {
      if (!name) return;
      if (prevSpeaker && prevSpeaker !== name) {
        drawTransfer(prevSpeaker, name);
      }
      prevSpeaker = name;
      setActivePlanet(name);
    }

    function setStatus(text) {
      if (statusEl) statusEl.textContent = text;
    }

    function resize() {
      // Force a relayout if the container size changed significantly.
      // We just recompute orbits from current graphNodes keys.
      // Not called automatically — caller can wire this to a ResizeObserver
      // if they need it. For the current pages, the orbital math uses
      // getBoundingClientRect at draw time, so labels stay correct even
      // without an explicit resize pass.
    }

    function destroy() {
      clearOrbitChildren();
      if (graphSvg) graphSvg.innerHTML = "";
      if (sunCoreEl) {
        sunCoreEl.setAttribute("data-hidden", "1");
        sunCoreEl.classList.remove("active");
        sunCoreEl.removeAttribute("data-name");
      }
      graphNodes.clear();
      graphLeaderName = null;
      prevSpeaker = null;
    }

    // Initial layout from options (if provided). The /demo page will
    // call layout() later when the server emits its `agents` event.
    if (opts.leader || (Array.isArray(opts.agents) && opts.agents.length)) {
      layout(opts.leader || null, opts.agents || []);
    }

    // Ambient mode: gently cycle the "active" glow around each planet
    // in sequence so the landing hero still feels alive without any
    // WebSocket input.
    let ambientTimer = null;
    if (mode === "ambient") {
      const names = [];
      if (opts.leader && opts.leader.name) names.push(opts.leader.name);
      (opts.agents || []).forEach((a) => a && a.name && names.push(a.name));
      if (names.length > 1) {
        let idx = 0;
        const cycle = () => {
          const current = names[idx % names.length];
          const next = names[(idx + 1) % names.length];
          setActivePlanet(current);
          setTimeout(() => {
            drawTransfer(current, next);
          }, 400);
          idx += 1;
        };
        cycle();
        ambientTimer = setInterval(cycle, 3400);
      }
    }

    return {
      layout,
      setActivePlanet,
      setSpeaker,
      drawTransfer,
      setStatus,
      resize,
      destroy: function () {
        if (ambientTimer) {
          clearInterval(ambientTimer);
          ambientTimer = null;
        }
        destroy();
      },
      // Introspection
      get leaderName() {
        return graphLeaderName;
      },
      get container() {
        return container;
      },
    };
  }

  // Expose to both global and (if present) module.exports for tests.
  window.createSolarSystem = createSolarSystem;
  window.COSMIC_PLANET_PALETTE = PLANET_PALETTE;
})();
