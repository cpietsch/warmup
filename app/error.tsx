"use client";

import { useEffect } from "react";

// Anything that breaks a page, instead of Next's bare "This page couldn't load". Practice history
// lives in this browser, so a reload loses nothing; it's what fixed these errors when we saw them.
export default function Error({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => console.error(error), [error]);
  return (
    <main className="wrap center-state">
      <h1 className="h2">This page didn&rsquo;t load</h1>
      <p className="lede">Your practice sessions are saved in this browser. Reloading usually fixes this.</p>
      <button className="btn" onClick={() => window.location.reload()}>
        Reload the page
      </button>
    </main>
  );
}
