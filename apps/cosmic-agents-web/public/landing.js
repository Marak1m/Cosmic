/* =========================================================
   COSMIC LANDING — ambient solar-system hero
   -----------------------------------------------------------
   The landing page shares the same solar-system component as
   the /demo mission view so the whole site feels coherent.
   Here we run it in "ambient" mode: no WebSocket, no real
   agents — just a rotating cast of placeholder specialists
   with the Leader sun at the centre.
   ========================================================= */

(function () {
  function boot() {
    if (typeof window.createSolarSystem !== "function") return;
    const el = document.getElementById("landing-solar");
    if (!el) return;

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
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    // Defer one frame so the container has its final layout size before
    // we compute orbit radii.
    window.requestAnimationFrame(boot);
  }
})();
