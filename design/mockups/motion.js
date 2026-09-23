// The gate board's motion, shared by the wall screen and the launch page's replay. A status tile flaps from one word to
// the next, rows close up in place when the board re-sorts, a logged row lifts off toward the pass, and a new pass
// tears over the old one from the board's side. Every move starts from what is already on screen, and under reduced
// motion the value changes in place with no movement at all.
window.tolseyMotion = (() => {
  const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const arrive = 'cubic-bezier(0.16, 1, 0.3, 1)';
  const leave = 'cubic-bezier(0.7, 0, 0.84, 0)';
  // A cancelled animation rejects its finished promise, and here a cancelled move counts as a finished one.
  const done = (animation) => animation.finished.catch(() => undefined);

  // The newest flap on a tile owns it: a quicker Next or a second reading cancels the one in flight, whose word is
  // then never written over the newer one.
  let flaps = 0;
  const flap = async (tile, change) => {
    const id = String((flaps += 1));
    tile.dataset.flap = id;
    tile.getAnimations().forEach((animation) => animation.cancel());
    if (reduced()) {
      change();
      return;
    }
    await done(tile.animate([{ transform: 'perspective(400px) rotateX(0deg)' }, { transform: 'perspective(400px) rotateX(-90deg)' }], { duration: 120, easing: leave }));
    if (tile.dataset.flap !== id) return;
    change();
    await done(tile.animate([{ transform: 'perspective(400px) rotateX(90deg)' }, { transform: 'none' }], { duration: 200, easing: arrive }));
  };

  const where = (elements) => new Map(elements.map((element) => [element, element.getBoundingClientRect()]));

  // First and last positions: a row that kept its identity slides from where it stood to where the new ranking puts it.
  const closeUp = (before) => {
    if (reduced()) return Promise.resolve();
    const moves = [];
    before.forEach((was, element) => {
      if (element.hidden || !element.isConnected) return;
      const dy = was.top - element.getBoundingClientRect().top;
      if (Math.abs(dy) < 1) return;
      moves.push(done(element.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 320, easing: arrive })));
    });
    return Promise.all(moves);
  };

  const liftOff = (row, toward) => {
    if (reduced()) return Promise.resolve();
    const to = { left: 'translateX(-40px)', up: 'translateY(-16px)' }[toward];
    return done(row.animate([{ transform: 'none', opacity: 1 }, { transform: to, opacity: 0 }], { duration: 220, easing: leave, fill: 'forwards' }));
  };

  // The new pass is revealed from its tear line over the old pass, which stays on screen underneath until it is covered.
  const tearOver = (pass, from) => {
    if (reduced()) return Promise.resolve();
    const [clip, shift] = {
      right: ['inset(0 0 0 100%)', 'translateX(28px)'],
      bottom: ['inset(100% 0 0 0)', 'translateY(20px)'],
      top: ['inset(0 0 100% 0)', 'translateY(-20px)'],
    }[from];
    return done(pass.animate([{ clipPath: clip, transform: shift }, { clipPath: 'inset(0 0 0 0)', transform: 'none' }], { duration: 420, easing: arrive }));
  };

  // A pass whose content changed in place slides a short way in from its board's side, never from invisible.
  const nudge = (element, from) => {
    element.getAnimations().forEach((animation) => animation.cancel());
    if (reduced()) return Promise.resolve();
    const shift = { right: 'translateX(18px)', bottom: 'translateY(14px)', top: 'translateY(-14px)' }[from];
    return done(element.animate([{ transform: shift }, { transform: 'none' }], { duration: 260, easing: arrive }));
  };

  return { reduced, flap, where, closeUp, liftOff, tearOver, nudge };
})();
