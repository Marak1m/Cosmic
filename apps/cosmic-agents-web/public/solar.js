/* =========================================================
   COSMIC SOLAR SYSTEM — shared component factory
   -----------------------------------------------------------
   Used by both the landing hero (ambient mode — no speaker
   switching, just orbital motion) and the /demo mission view
   (live mode — driven by WebSocket events).

   Global export: window.createSolarSystem(containerEl, opts)
   Returns an instance with:
     - layout(leader, agents)     ← (re)build orbits
     - setActivePlanet(name)      ← glow the agent that's speaking
     - setSpeaker(name)           ← halo transfer + glow
     - drawTransfer(from, to)     ← one-shot comet trail
     - destroy()                  ← tear down DOM + listeners
     - setStatus(text)            ← write to graph-status element

   Design notes (recent fixes):

   * Planets never overlap. All orbits share the same animation
     duration — this means every planet advances at the same
     angular rate. Combined with evenly-spaced initial phases
     (`i * 360 / n`), the angular separation between any two
     planets is constant forever; their labels can never drift
     into the same radial line. This replaces the earlier
     mixed-period + golden-angle scheme that looked pretty
     for the first few seconds and then smashed labels.

   * Comet follows the speaker. Instead of a fire-and-forget
     arc on every turn change, the instance keeps a persistent
     `.graph-halo` SVG group (glow ring + orbiting satellite)
     re-anchored to the current speaker's planet every RAF.
     When the speaker changes, we play a short transfer comet
     from the previous planet to the new one, then re-attach
     the halo. The halo is what the user reads as "this agent
     is currently responding."
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

  // Every orbit rotates at the same angular rate — this is the knob
  // that guarantees "no two planets ever line up." Tune for how
  // "lively" the scene feels without making motion dizzying.
  const ORBIT_PERIOD_S = 46;

  const SVGNS = "http://www.w3.org/2000/svg";

  function createSolarSystem(container, options) {
    if (!container) {
      throw new Error("createSolarSystem: container element is required");
    }
    const opts = options || {};
    const mode = opts.mode || "live"; // "ambient" | "live"
    const statusEl = opts.statusEl || null;

    // Instance-scoped state (so two instances don't share DOM refs)
    const graphNodes = new Map(); // agentName → planet element (or sun-core for Leader)
    let graphLeaderName = null;
    let sunCoreEl = null;
    let graphSvg = null;
    let prevSpeaker = null;

    // Halo state — persistent SVG elements that track the current
    // speaker's planet. Created lazily inside ensureHalo().
    let haloGroup = null;
    let haloRing = null;
    let haloSatellite = null;
    let haloTargetName = null;
    let haloRaf = 0;

    if (!container.classList.contains("solar-system")) {
      container.classList.add("solar-system");
    }

    // Ensure the SVG comet-trail layer exists.
    graphSvg = container.querySelector(".graph-lines");
    if (!graphSvg) {
      graphSvg = document.createElementNS(SVGNS, "svg");
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
      // Reset halo on every layout so we don't hold a stale ref.
      unpinHalo();

      clearOrbitChildren();
      graphNodes.clear();
      graphLeaderName = leader ? leader.name : null;
      prevSpeaker = null;

      if (leader && sunCoreEl) {
        sunCoreEl.removeAttribute("data-hidden");
        sunCoreEl.setAttribute("data-name", String(leader.name || "Leader").replace(/_/g, " "));
        sunCoreEl.dataset.agent = leader.name;
        graphNodes.set(leader.name, sunCoreEl);
      }

      const list = Array.isArray(agents) ? agents : [];
      const n = list.length;
      if (!n) {
        if (statusEl) {
          statusEl.textContent = leader ? "1 body in orbit" : "Waiting for crew...";
        }
        return;
      }

      const stageRect = container.getBoundingClientRect();
      const usable = Math.min(stageRect.width || 440, stageRect.height || 440);

      // Outer orbit has to stay ~70px from the container edge so
      // planet labels don't clip the panel border.
      const maxRadius = Math.max(130, usable / 2 - 70);

      // Inner orbit sits far enough from the sun to avoid label
      // crunch against the sun's halo.
      const baseRadius = Math.max(110, usable * 0.24);

      // Radial step: the gap between one orbit and the next. A planet
      // body is ~56px and a label stack is ~48px tall, so we need at
      // least ~60px between rings or the inner planet's label crashes
      // into the next orbit's body.
      const rawStep = n > 1 ? (maxRadius - baseRadius) / (n - 1) : 0;
      const step = n > 1 ? Math.max(60, rawStep) : 0;

      list.forEach((agent, i) => {
        const candidate = baseRadius + i * step;
        const radius = Math.min(candidate, maxRadius);
        const diameter = radius * 2;

        // Evenly-spaced angles across the full circle. Because every
        // orbit shares ORBIT_PERIOD_S, this separation stays constant.
        const angleDeg = (i * 360) / n;
        const delay = -((ORBIT_PERIOD_S * angleDeg) / 360);

        const palette = PLANET_PALETTE[i % PLANET_PALETTE.length];

        const orbit = document.createElement("div");
        orbit.className = "orbit";
        orbit.style.width = diameter + "px";
        orbit.style.height = diameter + "px";
        orbit.style.animationDuration = ORBIT_PERIOD_S + "s";
        orbit.style.animationDelay = delay + "s";

        const anchor = document.createElement("div");
        anchor.className = "planet-anchor";
        anchor.style.animationDuration = ORBIT_PERIOD_S + "s";
        anchor.style.animationDelay = delay + "s";

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
        const total = (leader ? 1 : 0) + n;
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

    // ---------- Transfer comet (one-shot, on speaker change) ----------

    function drawTransfer(fromName, toName) {
      if (!graphSvg || !fromName || !toName || fromName === toName) {
        return Promise.resolve();
      }
      const fromEl = graphNodes.get(fromName);
      const toEl = graphNodes.get(toName);
      if (!fromEl || !toEl) return Promise.resolve();

      const stageRect = container.getBoundingClientRect();
      if (!stageRect.width) return Promise.resolve();

      graphSvg.setAttribute(
        "viewBox",
        "0 0 " + stageRect.width + " " + stageRect.height
      );

      const isLeader = fromName === graphLeaderName;

      const path = document.createElementNS(SVGNS, "path");
      path.setAttribute("data-leader", String(isLeader));
      path.classList.add("graph-arrow");
      graphSvg.appendChild(path);

      const dot = document.createElementNS(SVGNS, "circle");
      dot.setAttribute("r", "5");
      dot.setAttribute("data-leader", String(isLeader));
      dot.classList.add("graph-dot");
      graphSvg.appendChild(dot);

      return new Promise((resolve) => {
        let t0 = null;
        const dur = 620;

        function easeInOut(p) {
          return p < 0.5 ? 2 * p * p : -1 + (4 - 2 * p) * p;
        }

        function buildPath() {
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
            resolve();
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
                resolve();
              }, 450);
            }, 160);
          }
        }

        requestAnimationFrame(tick);
      });
    }

    // ---------- Halo (persistent, tracks the current speaker) ----------

    function ensureHalo() {
      if (haloGroup) return;
      haloGroup = document.createElementNS(SVGNS, "g");
      haloGroup.classList.add("graph-halo");
      haloGroup.setAttribute("data-hidden", "1");

      haloRing = document.createElementNS(SVGNS, "circle");
      haloRing.classList.add("graph-halo-ring");
      haloRing.setAttribute("r", "38");
      haloGroup.appendChild(haloRing);

      // Satellite dot orbits the halo center via a pure SVG rotation,
      // driven by CSS — no JS per-frame cost beyond the anchor update.
      const satelliteWrap = document.createElementNS(SVGNS, "g");
      satelliteWrap.classList.add("graph-halo-satellite");
      haloSatellite = document.createElementNS(SVGNS, "circle");
      haloSatellite.classList.add("graph-halo-satellite-dot");
      haloSatellite.setAttribute("r", "3.5");
      haloSatellite.setAttribute("cx", "38"); // orbit radius around halo center
      haloSatellite.setAttribute("cy", "0");
      satelliteWrap.appendChild(haloSatellite);
      haloGroup.appendChild(satelliteWrap);
      haloGroup.__satelliteWrap = satelliteWrap;

      graphSvg.appendChild(haloGroup);
    }

    function haloLoop() {
      if (!haloTargetName) {
        haloRaf = 0;
        return;
      }
      const targetEl = graphNodes.get(haloTargetName);
      if (!targetEl || !graphSvg) {
        haloRaf = requestAnimationFrame(haloLoop);
        return;
      }
      const stageRect = container.getBoundingClientRect();
      if (stageRect.width) {
        graphSvg.setAttribute(
          "viewBox",
          "0 0 " + stageRect.width + " " + stageRect.height
        );
        const pt = getOrbitPoint(targetEl, stageRect);
        // Position the whole halo group via transform. The satellite
        // wrap inside rotates on its own via CSS animation.
        haloGroup.setAttribute("transform", `translate(${pt.x} ${pt.y})`);
        if (haloGroup.__satelliteWrap) {
          // Keep the satellite wrap centered on the halo; CSS handles rotation.
          haloGroup.__satelliteWrap.setAttribute("transform", "");
        }
      }
      haloRaf = requestAnimationFrame(haloLoop);
    }

    function pinHaloTo(name) {
      if (!name || !graphNodes.has(name)) {
        unpinHalo();
        return;
      }
      ensureHalo();
      haloTargetName = name;
      haloGroup.removeAttribute("data-hidden");
      haloGroup.dataset.agent = name;
      haloGroup.dataset.leader = String(name === graphLeaderName);
      if (!haloRaf) {
        haloRaf = requestAnimationFrame(haloLoop);
      }
    }

    function unpinHalo() {
      haloTargetName = null;
      if (haloRaf) {
        cancelAnimationFrame(haloRaf);
        haloRaf = 0;
      }
      if (haloGroup) {
        haloGroup.setAttribute("data-hidden", "1");
      }
    }

    // ---------- Speaker event API ----------

    // setSpeaker is the main public entry for live mode. On every
    // speaker change we (a) play a transfer comet from the previous
    // planet to the new one, (b) re-anchor the halo to the new
    // planet, and (c) flip the glow class. The halo keeps orbiting
    // the active planet until the next setSpeaker call.
    function setSpeaker(name) {
      if (!name) return;
      const isNewSpeaker = prevSpeaker && prevSpeaker !== name;
      setActivePlanet(name);

      if (isNewSpeaker) {
        // Briefly hide the halo so the comet reads as "the floor
        // transferring," then re-pin once the comet lands.
        unpinHalo();
        drawTransfer(prevSpeaker, name).then(() => {
          pinHaloTo(name);
        });
      } else {
        pinHaloTo(name);
      }
      prevSpeaker = name;
    }

    function setStatus(text) {
      if (statusEl) statusEl.textContent = text;
    }

    function resize() {
      // Orbital math uses getBoundingClientRect at draw time, so
      // labels stay correct without an explicit resize pass. This
      // stub is here in case callers want to force a relayout.
    }

    function destroy() {
      unpinHalo();
      if (haloGroup) {
        haloGroup.remove();
        haloGroup = null;
        haloRing = null;
        haloSatellite = null;
      }
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

    // Initial layout from options.
    if (opts.leader || (Array.isArray(opts.agents) && opts.agents.length)) {
      layout(opts.leader || null, opts.agents || []);
    }

    // Ambient mode: cycle the "active" glow around each planet in
    // sequence so the landing hero feels alive without WS input.
    let ambientTimer = null;
    if (mode === "ambient") {
      const names = [];
      if (opts.leader && opts.leader.name) names.push(opts.leader.name);
      (opts.agents || []).forEach((a) => a && a.name && names.push(a.name));
      if (names.length > 1) {
        let idx = 0;
        const cycle = () => {
          const current = names[idx % names.length];
          setSpeaker(current);
          idx += 1;
        };
        cycle();
        ambientTimer = setInterval(cycle, 3600);
      } else if (names.length === 1) {
        setSpeaker(names[0]);
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

  window.createSolarSystem = createSolarSystem;
  window.COSMIC_PLANET_PALETTE = PLANET_PALETTE;
})();
