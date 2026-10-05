import { useState } from 'react';

/** Yarnoo lockup with a text fallback if the SVG fails to load. */
export function BrandLogo({ src = '/brand/yarnoo-logo-white.svg', alt = 'Yarnoo' }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <span className="wordmark">yarnoo</span>;
  return <img src={src} alt={alt} onError={() => setFailed(true)} />;
}
