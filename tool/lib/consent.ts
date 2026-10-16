import type { Frame, Page } from 'playwright';

export interface ConsentResult { action: 'rejected' | 'hidden' | 'none'; detail: string }

// Pure and self-contained (also injected into pages). True only for labels that refuse
// optional cookies. Anything that accepts or allows everything is never a match.
export function isRejectLabel(label: string): boolean {
  const text = label.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!text || text.length > 60) return false;
  const essentialOnly = /\b(necessary|essential|required|strictly necessary)\b/.test(text) && !/\ball\b/.test(text);
  if (/\b(accept|allow|agree|ok|okay|got it|yes|enable)\b/.test(text) && !essentialOnly) return false;
  if (/\b(reject|decline|deny|refuse|disagree|opt out|opt-out)\b/.test(text)) return true;
  if (/^continue without (accepting|agreeing)/.test(text)) return true;
  return essentialOnly && /\b(only|just)\b/.test(text);
}

// Reject buttons of common consent platforms. Never their accept buttons.
export const KNOWN_REJECT_SELECTORS = [
  '#onetrust-reject-all-handler', '.ot-pc-refuse-all-handler',
  '#CybotCookiebotDialogBodyButtonDecline', '#CybotCookiebotDialogBodyLevelButtonLevelOptinDeclineAll',
  '#didomi-notice-disagree-button', '.cky-btn-reject', '.cmplz-deny', '.iubenda-cs-reject-btn',
  '.osano-cm-denyAll', '[data-tid="banner-decline"]', '.cm-btn-decline', '#truste-consent-required',
  '.qc-cmp2-summary-buttons button[mode="secondary"]', '[data-testid="uc-deny-all-button"]'
];

const CONSENT_TEXT = /cookie|consent|gdpr|privacy preferences|tracking technologies/i;

async function clickKnown(frame: Frame): Promise<string | null> {
  for (const selector of KNOWN_REJECT_SELECTORS) {
    const target = frame.locator(selector).first();
    if (await target.isVisible().catch(() => false)) {
      await target.click({ timeout: 3000 });
      return selector;
    }
  }
  return null;
}

async function clickByLabel(frame: Frame): Promise<string | null> {
  // Sent as script source (not `new Function` inside the page), so strict CSP sites still work.
  const label = await frame.evaluate<string | null>(`(${findRejectControl.toString()})(${isRejectLabel.toString()}, ${JSON.stringify(CONSENT_TEXT.source)})`);
  if (!label) return null;
  await frame.locator('[data-site-lab-reject]').first().click({ timeout: 3000 });
  return label;
}

// Runs inside the page. Marks the first visible refusal control that sits inside a consent UI.
function findRejectControl(isReject: (label: string) => boolean, consentText: string): string | null {
    for (const marked of document.querySelectorAll('[data-site-lab-reject]')) marked.removeAttribute('data-site-lab-reject');
    const consent = new RegExp(consentText, 'i');
    const visible = (el: Element) => {
      const rect = el.getBoundingClientRect(); const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const controls = [...document.querySelectorAll('button, [role="button"], a, input[type="button"], input[type="submit"]')];
    for (const control of controls) {
      const text = (control as HTMLInputElement).value || control.getAttribute('aria-label') || (control as HTMLElement).innerText || '';
      if (!visible(control) || !isReject(text)) continue;
      // Only inside something that is about cookies or consent.
      let inConsent = false;
      // A small container, never the page itself: a footer "Cookie policy" link must not qualify a random button.
      for (let el: Element | null = control.parentElement, depth = 0; el && el !== document.body && depth < 8; el = el.parentElement, depth++) {
        if (((el as HTMLElement).innerText ?? '').length > 3000) break;
        if (consent.test(`${el.id} ${el.className} ${el.getAttribute('aria-label') ?? ''}`) || consent.test((el as HTMLElement).innerText ?? '')) { inConsent = true; break; }
      }
      if (!inConsent) continue;
      control.setAttribute('data-site-lab-reject', '');
      return text.trim().slice(0, 80);
    }
    return null;
}

async function hideBanner(page: Page): Promise<string | null> {
  return page.evaluate(consentText => {
    const consent = new RegExp(consentText, 'i');
    const hidden: string[] = [];
    for (const el of document.querySelectorAll('body *')) {
      const style = getComputedStyle(el);
      if (!['fixed', 'sticky'].includes(style.position) || style.display === 'none' || style.visibility === 'hidden') continue;
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height || rect.width * rect.height > innerWidth * innerHeight * 0.7) continue;
      if (!consent.test((el as HTMLElement).innerText ?? '') && !consent.test(`${el.id} ${el.className}`)) continue;
      (el as HTMLElement).style.setProperty('visibility', 'hidden', 'important');
      hidden.push(el.id ? `#${el.id}` : el.localName);
    }
    if (hidden.length) {
      // Consent modals often lock scrolling; capturing needs it back.
      for (const el of [document.documentElement, document.body]) el.style.setProperty('overflow', 'visible', 'important');
    }
    return hidden.length ? hidden.join(', ') : null;
  }, CONSENT_TEXT.source);
}

/** Some consent platforms reload the page after a choice (some do, ~1–2s later). Wait that out. */
async function settleAfterChoice(page: Page, watchMs = 3000): Promise<boolean> {
  let navigated = false;
  const onNavigate = (frame: Frame) => { if (frame === page.mainFrame()) navigated = true; };
  page.on('framenavigated', onNavigate);
  try { await page.waitForTimeout(watchMs); } finally { page.off('framenavigated', onNavigate); }
  if (navigated) {
    await page.waitForLoadState('load', { timeout: 30000 }).catch(() => undefined);
    await page.waitForTimeout(500);
  }
  return navigated;
}

/** Refuse optional cookies when a banner offers it; otherwise hide the banner. Never accepts. */
export async function dismissConsent(page: Page, waitMs = 4000): Promise<ConsentResult> {
  const deadline = Date.now() + waitMs;
  do {
    for (const frame of page.frames()) {
      try {
        const known = await clickKnown(frame).catch(() => null);
        const label = known ? null : await clickByLabel(frame);
        const detail = known ?? (label ? `button "${label}"` : null);
        if (detail) {
          const reloaded = await settleAfterChoice(page);
          return { action: 'rejected', detail: reloaded ? `${detail}; the site reloaded the page afterwards` : detail };
        }
      } catch { /* detached or cross-origin frame: try the next one */ }
    }
    await page.waitForTimeout(400);
  } while (Date.now() < deadline);
  const hidden = await hideBanner(page).catch(() => null);
  return hidden ? { action: 'hidden', detail: hidden } : { action: 'none', detail: 'no consent banner found' };
}
