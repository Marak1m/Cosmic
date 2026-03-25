const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function initFlowDiagram() {
  const stage = document.getElementById("flow-stage");
  const caption = document.getElementById("orbit-caption");
  if (!stage || !caption) return;

  const svg = stage.querySelector("svg.flow-lines");
  if (!svg) return;

  const leaderName = "Leader";
  const selectorName = "Speaker_Selector";
  const memoryName = "Shared_Memory";

  const agentNames = [
    leaderName,
    "Research_Specialist",
    "Domain_Specialist",
    "Quality_Reviewer",
    "Implementation_Specialist",
  ];

  const leaderCheckInInterval = 10;

  const nodes = new Map();
  stage.querySelectorAll(".flow-node").forEach((node) => {
    const name = node.dataset.agent;
    if (name) nodes.set(name, node);
  });

  const edges = new Map();
  const edgeKey = (a, b) => (a < b ? `${a}::${b}` : `${b}::${a}`);

  const createEdge = (a, b, kind) => {
    if (!nodes.has(a) || !nodes.has(b)) return;
    const key = edgeKey(a, b);
    if (edges.has(key)) return;

    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.classList.add("flow-line", `kind-${kind}`);
    line.dataset.a = a;
    line.dataset.b = b;
    svg.appendChild(line);
    edges.set(key, line);
  };

  agentNames.forEach((name) => {
    createEdge(selectorName, name, "selector");
    createEdge(memoryName, name, "memory");
  });

  const layoutEdges = () => {
    const stageRect = stage.getBoundingClientRect();
    const width = Math.max(1, stageRect.width);
    const height = Math.max(1, stageRect.height);

    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("preserveAspectRatio", "none");

    edges.forEach((line) => {
      const aNode = nodes.get(line.dataset.a);
      const bNode = nodes.get(line.dataset.b);
      if (!aNode || !bNode) return;

      const aRect = aNode.getBoundingClientRect();
      const bRect = bNode.getBoundingClientRect();

      const x1 = aRect.left - stageRect.left + aRect.width / 2;
      const y1 = aRect.top - stageRect.top + aRect.height / 2;
      const x2 = bRect.left - stageRect.left + bRect.width / 2;
      const y2 = bRect.top - stageRect.top + bRect.height / 2;

      line.setAttribute("x1", x1);
      line.setAttribute("y1", y1);
      line.setAttribute("x2", x2);
      line.setAttribute("y2", y2);
    });
  };

  if ("ResizeObserver" in window) {
    const observer = new ResizeObserver(() => layoutEdges());
    observer.observe(stage);
  }

  window.addEventListener("resize", layoutEdges);
  window.requestAnimationFrame(() => {
    layoutEdges();
    window.requestAnimationFrame(layoutEdges);
  });

  const specialists = agentNames.filter((name) => name !== leaderName);
  let turn = 1;
  let specialistIndex = 0;
  let currentSpeaker = leaderName;

  const clearHighlights = () => {
    stage.querySelectorAll(".flow-node").forEach((node) => {
      node.classList.remove("active", "pulse");
    });
    edges.forEach((line) => line.classList.remove("active", "broadcast"));
  };

  const highlightEdge = (a, b, klass) => {
    const line = edges.get(edgeKey(a, b));
    if (line) line.classList.add(klass);
  };

  const showBroadcast = (speaker) => {
    clearHighlights();
    nodes.get(speaker)?.classList.add("active");
    if (!prefersReducedMotion) {
      nodes.get(memoryName)?.classList.add("pulse");
    }

    highlightEdge(memoryName, speaker, "active");
    agentNames.forEach((name) => {
      if (name !== speaker) {
        highlightEdge(memoryName, name, "broadcast");
      }
    });

    caption.textContent = `Turn ${turn}: ${speaker} speaks. Shared_Memory updates for everyone.`;
  };

  const showSelection = (speaker, nextSpeaker) => {
    clearHighlights();
    nodes.get(speaker)?.classList.add("active");
    nodes.get(selectorName)?.classList.add("active");
    nodes.get(nextSpeaker)?.classList.add("active");

    highlightEdge(selectorName, speaker, "active");
    highlightEdge(selectorName, nextSpeaker, "active");

    caption.textContent = `Turn ${turn}: Speaker_Selector routes the next turn to ${nextSpeaker}.`;
  };

  const pickNextSpeaker = () => {
    if (turn % leaderCheckInInterval === 0) {
      return leaderName;
    }
    const next = specialists[specialistIndex % specialists.length];
    specialistIndex += 1;
    return next;
  };

  const runTurn = () => {
    const nextSpeaker = pickNextSpeaker();
    showBroadcast(currentSpeaker);

    window.setTimeout(() => {
      showSelection(currentSpeaker, nextSpeaker);
    }, prefersReducedMotion ? 1200 : 1700);

    window.setTimeout(() => {
      currentSpeaker = nextSpeaker;
      turn += 1;
      runTurn();
    }, prefersReducedMotion ? 2600 : 3600);
  };

  runTurn();
}

window.setTimeout(initFlowDiagram, 60);
