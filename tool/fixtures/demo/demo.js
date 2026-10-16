/* Original local fixture code; libraries are served directly from installed node_modules. */
window.gsap.registerPlugin(window.ScrollTrigger);
window.lenis = new window.Lenis({ lerp: 0.12, smoothWheel: true, wheelMultiplier: 1 });
window.lenis.on('scroll', window.ScrollTrigger.update);
window.gsap.ticker.add(time => window.lenis.raf(time * 1000));
window.gsap.ticker.lagSmoothing(0);
const pulse = document.querySelector('#badge').animate([
  { backgroundColor: '#c3d9fa', boxShadow: '0 0 0 0px rgba(48,69,104,0.2)' },
  { backgroundColor: '#e9f1ff', boxShadow: '0 0 0 12px rgba(48,69,104,0)' },
  { backgroundColor: '#c3d9fa', boxShadow: '0 0 0 0px rgba(48,69,104,0.2)' }
], { duration: 2000, iterations: Infinity, easing: 'ease-in-out' });
pulse.id = 'pulse';
// Timed-change fixture: a phrase that rotates on its own every second, as in many landing-page heroes.
const phrases = ['Posted $1,408 in payments', 'Reconciled $13,201 in claims', 'Filed 42 claims today'];
let phrase = 0;
setInterval(() => { phrase = (phrase + 1) % phrases.length; document.querySelector('#rotator').textContent = phrases[phrase]; }, 1000);
// Timed-change fixture: all phrases stay in the DOM and take turns, moved by inline styles every frame.
const tasks = [...document.querySelectorAll('#task-stack .task')];
let task = 0;
tasks.forEach((el, i) => { el.style.transform = `translateY(${i === 0 ? 0 : 100}%)`; });
const slide = (el, from, to) => {
  const start = performance.now();
  const frame = now => { const p = Math.min(1, (now - start) / 300); el.style.transform = `translateY(${from + (to - from) * p}%)`; if (p < 1) requestAnimationFrame(frame); };
  requestAnimationFrame(frame);
};
setInterval(() => { const next = (task + 1) % tasks.length; slide(tasks[task], 0, -100); slide(tasks[next], 100, 0); task = next; }, 1200);
// Consent fixture: appears after a delay, like real banners. The server logs which choice was made.
setTimeout(() => { document.querySelector('#consent').hidden = false; }, 600);
for (const choice of ['accept', 'reject']) document.querySelector('#consent-' + choice).addEventListener('click', () => {
  fetch('/consent/' + choice); document.querySelector('#consent').remove();
});
// Regression fixture: a listed hover target that detaches before it is reached (as seen on a real site).
document.querySelector('#hover-round').addEventListener('mouseenter', () => document.querySelector('#vanishing-link')?.remove());
window.gsap.to('#scrub-panel', {
  x: -600, ease: 'none',
  scrollTrigger: { trigger: '#pin-section', start: 'top top', end: '+=1000', pin: true, scrub: true }
});
window.gsap.fromTo('#inside-loop', { y: 0 }, {
  y: -120, ease: 'none',
  scrollTrigger: { trigger: '.ambient-section', start: 'top bottom', end: 'bottom top', scrub: true }
});
window.gsap.fromTo('#parallax-image', { yPercent: -20 }, {
  yPercent: 20, ease: 'none',
  scrollTrigger: { trigger: '#parallax-section', start: 'top bottom', end: 'bottom top', scrub: true }
});
