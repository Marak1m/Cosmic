/* =========================================================
   /how page — spawns an ambient solar-system figure.
   No WebSocket, no speaker switching: just orbital motion
   with a looping "active glow" handed off between planets.
   ========================================================= */
(function () {
  "use strict";

  var el = document.getElementById("how-solar");
  if (!el || typeof window.createSolarSystem !== "function") {
    return;
  }

  window.createSolarSystem(el, {
    mode: "ambient",
    leader: { name: "Leader" },
    agents: [
      { name: "Research_Specialist" },
      { name: "Domain_Expert" },
      { name: "Quality_Reviewer" },
      { name: "Implementation" },
    ],
  });
})();
