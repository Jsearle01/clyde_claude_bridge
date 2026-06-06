// CB-DAEMON-LIFECYCLE-FIX (c2): the offline page must be LEGIBLE — it used to
// conflate four distinct states behind one generic "no extension connected"
// message. It now distinguishes the two the daemon can actually tell apart
// (no extension here vs. connected-but-unregistered) and enumerates all four
// likely causes so the operator isn't guessing.

import { describe, it, expect } from "vitest";
import { extensionOfflinePage } from "../../src/oauth/templates.js";

describe("extensionOfflinePage legibility (CB-DAEMON-LIFECYCLE-FIX c2)", () => {
  it("no extension connected: names that state + enumerates the four causes", () => {
    const html = extensionOfflinePage(false);
    expect(html).toContain("No VS Code extension is connected to this daemon");
    // The four real causes are enumerated.
    expect(html).toContain("no folder");
    expect(html).toContain("trusted");
    expect(html).toContain("different daemon");
    // Points the operator at the diagnostic command.
    expect(html).toContain("claude-bridge status");
  });

  it("connected-but-unregistered: says an extension IS connected but unregistered", () => {
    const html = extensionOfflinePage(true);
    expect(html).toContain(
      "A VS Code window is connected, but no workspace is registered",
    );
    // Still actionable (open a folder + complete Trust).
    expect(html).toContain("Trust");
  });

  it("defaults to the conservative 'no extension' page", () => {
    expect(extensionOfflinePage()).toContain(
      "No VS Code extension is connected to this daemon",
    );
  });
});
