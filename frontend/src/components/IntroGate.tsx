import { lazy, Suspense, useState } from 'react';
import { usePrefs } from '../lib/prefs';

const Intro = lazy(() => import('./Intro'));
const SEEN = 'terrax_intro_seen';

/** Whether to play the opening animation: once per browser tab, unless turned off (or ?intro=1 to see it again). */
function wanted(on: boolean): boolean {
  try {
    if (new URLSearchParams(window.location.search).has('intro')) return true;
    if (!on || navigator.webdriver || sessionStorage.getItem(SEEN)) return false;
  } catch {
    return false;
  }
  return true;
}

export default function IntroGate() {
  const { intro } = usePrefs();
  const [show, setShow] = useState(() => wanted(intro));
  if (!show) return null;
  const done = () => {
    try {
      sessionStorage.setItem(SEEN, '1');
    } catch {
      /* private mode: it simply plays again next time */
    }
    setShow(false);
  };
  return (
    <Suspense fallback={<div className="intro" />}>
      <Intro onDone={done} />
    </Suspense>
  );
}
