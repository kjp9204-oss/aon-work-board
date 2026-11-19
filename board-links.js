(() => {
  'use strict';

  const home = document.querySelector('[data-page="overview"]');
  for (const link of document.querySelectorAll('[data-overview-link]')) {
    link.addEventListener('click', event => {
      const target = document.getElementById(link.hash.slice(1));
      if (!target) return;
      event.preventDefault();
      home.click();
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: 'start' });
    });
  }

  const intake = document.getElementById('intakeLink');
  const pending = document.getElementById('intakePending');
  const syncIntake = () => { pending.hidden = !intake.hidden; };
  new MutationObserver(syncIntake).observe(intake, { attributes: true, attributeFilter: ['hidden'] });
  syncIntake();
})();
