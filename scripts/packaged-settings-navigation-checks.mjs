import { randomUUID } from 'node:crypto';

const sections = ['general', 'privacy', 'recursion', 'storage', 'developer'];

export async function runPackagedSettingsNavigationChecks({ cdp, poll, assert }) {
  const evidence = [];
  const token = randomUUID();
  let primaryFailure;
  try {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 700, deviceScaleFactor: 1, mobile: false });
    assert(await cdp.evaluate(`(() => { /*settings-nav:route*/
      const button = document.querySelector('[data-route="settings"]');
      if (!button) return false;
      button.click(); return true;
    })()`), 'Settings route is not reachable');
    await poll(() => cdp.evaluate(`document.querySelector('#page h1')?.textContent`), (value) => value === 'Settings', undefined, 'Settings page');
    const installed = await cdp.evaluate(`(() => { /*settings-nav:install*/
      if (Object.hasOwn(window, '__betaSettingsNavigation')) throw new Error('Settings test instrumentation already exists');
      const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
      if (typeof descriptor?.value !== 'function') throw new Error('Native scrollIntoView is unavailable');
      const state = { descriptor, token: ${JSON.stringify(token)}, calls: [], overflow: false };
      Object.defineProperty(Element.prototype, 'scrollIntoView', { ...descriptor, value: function(options) {
        const result = Reflect.apply(descriptor.value, this, [options]);
        if (this.matches('.settings-layout .settings-group')) {
          const heading = this.querySelector('h2');
          const stage = document.querySelector('#main-stage').getBoundingClientRect();
          const rect = heading.getBoundingClientRect();
          if (state.calls.length < 16) state.calls.push({ target: this.id, behavior: options?.behavior,
            focus: document.activeElement?.id, immediateVisible: rect.top >= stage.top && rect.bottom <= stage.bottom });
          else state.overflow = true;
        }
        return result;
      }});
      window.__betaSettingsNavigation = state;
      return [...document.querySelectorAll('.settings-nav button')].map((button) => {
        const id = button.getAttribute('aria-controls');
        const section = document.getElementById(id);
        const heading = section?.querySelector('h2');
        return { id, type: button.type, label: button.textContent, headingId: heading?.id,
          tabIndex: heading?.tabIndex, named: section?.getAttribute('aria-labelledby') === heading?.id,
          falselyActive: button.classList.contains('active') };
      });
    })()`);
    assert(Array.isArray(installed) && installed.length === 5, 'Settings navigation inventory is not five controls');
    installed.forEach((item, index) => assert(item.id === `settings-${sections[index]}` && item.type === 'button'
      && item.headingId === `${item.id}-heading` && item.tabIndex === -1 && item.named && !item.falselyActive,
    `Settings destination semantics invalid: ${sections[index]}`));

    for (const reduced of [true, false, true]) {
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' }] });
      const targets = evidence.length === 10 ? ['developer'] : sections;
      for (const section of targets) {
        const id = `settings-${section}`;
        const prepared = await cdp.evaluate(`(() => { /*settings-nav:prepare*/
          const id = ${JSON.stringify(id)};
          const button = [...document.querySelectorAll('.settings-nav button')].find((node) => node.getAttribute('aria-controls') === id);
          if (!button) return null;
          document.querySelector('#main-stage').scrollTo({ top: 0, behavior: 'instant' });
          button.focus({ preventScroll: true });
          const rect = button.getBoundingClientRect();
          return { focused: document.activeElement === button, reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
            x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        })()`);
        assert(prepared?.focused && prepared.reduced === reduced, `Settings navigation focus/media setup failed: ${id}`);
        const input = reduced ? 'pointer' : (sections.indexOf(section) % 2 ? 'Space' : 'Enter');
        if (input === 'pointer') {
          for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type,
            x: prepared.x, y: prepared.y, button: 'left', clickCount: 1 });
        } else {
          const key = input === 'Space' ? ' ' : 'Enter';
          const code = input === 'Space' ? 'Space' : 'Enter';
          const keyCode = input === 'Space' ? 32 : 13;
          await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode,
            text: input === 'Space' ? ' ' : '\r' });
          await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode });
        }
        const count = evidence.length + 1;
        const observation = await poll(() => cdp.evaluate(`(() => { /*settings-nav:snapshot*/
          const state = window.__betaSettingsNavigation;
          const id = ${JSON.stringify(id)};
          const heading = document.getElementById(id + '-heading');
          const rect = heading.getBoundingClientRect();
          const stage = document.querySelector('#main-stage').getBoundingClientRect();
          return { count: state.calls.length, overflow: state.overflow, last: state.calls.at(-1),
            focus: document.activeElement?.id, visible: rect.top >= stage.top && rect.bottom <= stage.bottom };
        })()`), (value) => value.count >= count && value.visible && value.focus === `${id}-heading`, undefined, `Settings ${input} ${id}`);
        assert(observation.count === count && !observation.overflow, 'Unexpected/missing Settings scroll calls');
        assert(observation.last.target === id && observation.last.focus === `${id}-heading`, 'Settings action reached the wrong destination');
        assert(observation.last.behavior === (reduced ? 'instant' : 'smooth'), 'Settings action ignored the current motion preference');
        assert(!reduced || observation.last.immediateVisible, 'Reduced-motion Settings jump was not immediately visible');
        evidence.push({ section, reduced, input, ...observation });
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
        const inSection = await cdp.evaluate(`document.activeElement?.closest('.settings-group')?.id === ${JSON.stringify(id)}`);
        assert(inSection === true, `Tab after Settings jump did not continue in ${id}`);
      }
    }
    return { viewportWidth: 1024, inventory: installed, activations: evidence,
      scope: 'Real packaged DOM, CDP pointer/Enter/Space/Tab defaults and live media emulation; not OS preference UI or screen-reader qualification.' };
  } catch (error) {
    primaryFailure = error;
    error.evidence = { activations: evidence };
    throw error;
  } finally {
    const cleanupErrors = [];
    const attemptCleanup = async (phase, action) => {
      try { await action(); }
      catch (error) { cleanupErrors.push({ phase, message: String(error?.message ?? error).slice(0, 1024) }); }
    };
    // A lost install response does not prove that renderer-side mutation failed.
    // Always probe, but restore only instrumentation owned by this invocation.
    await attemptCleanup('prototype', () => cdp.evaluate(`(() => { /*settings-nav:restore*/
        const state = window.__betaSettingsNavigation;
        if (!state || state.token !== ${JSON.stringify(token)}) return;
        Object.defineProperty(Element.prototype, 'scrollIntoView', state.descriptor);
        delete window.__betaSettingsNavigation;
        document.querySelector('#main-stage').scrollTo({ top: 0, behavior: 'instant' });
      })()`));
    await attemptCleanup('media', () => cdp.send('Emulation.setEmulatedMedia', { features: [] }));
    await attemptCleanup('viewport', () => cdp.send('Emulation.clearDeviceMetricsOverride'));
    if (cleanupErrors.length) {
      if (primaryFailure) primaryFailure.evidence.cleanupErrors = cleanupErrors;
      else {
        const error = new Error(`Settings test cleanup failed: ${cleanupErrors[0].message}`);
        error.evidence = { activations: evidence, cleanupErrors };
        throw error;
      }
    }
  }
}
