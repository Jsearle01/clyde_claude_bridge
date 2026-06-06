// T-P3-002: OAuth browser-surface HTML templates. Inline strings (no
// static-file serving — daemon has no asset infra). All self-referential
// URLs and links are derived from `deriveBaseUrl` (passed by callers
// per the verdict §1 constraint).
//
// 5 surfaces:
//   - pending     — meta-refresh to /authorize/status?request_id=…
//   - offline     — "no VS Code extension is connected" error
//   - ack-timeout — "extension is online but not responding" error
//   - decision-timeout — "consent window expired" error
//   - deny        — "you declined the request" error
//
// The pages use minimal, framework-free HTML with a small inline <style>
// for readability. Status code is the caller's responsibility (HTML body
// returned; caller writes the appropriate response code).

// ---------------------------------------------------------------------
// Shared chrome: doctype, head, basic styling. All pages share these so
// the visual experience stays consistent across error surfaces.
// ---------------------------------------------------------------------

interface ChromeOpts {
  title: string;
  meta_refresh_url?: string;
  meta_refresh_seconds?: number;
}

function chromeOpen(opts: ChromeOpts): string {
  const refresh = opts.meta_refresh_url !== undefined
    ? `<meta http-equiv="refresh" content="${opts.meta_refresh_seconds ?? 2};url=${escapeAttr(opts.meta_refresh_url)}">`
    : "";
  return [
    "<!DOCTYPE html>",
    "<html lang=\"en\">",
    "<head>",
    "<meta charset=\"utf-8\">",
    `<title>${escapeText(opts.title)}</title>`,
    refresh,
    "<style>",
    "  body { font-family: system-ui, -apple-system, sans-serif;",
    "         max-width: 36rem; margin: 4rem auto; padding: 0 1.5rem;",
    "         color: #222; line-height: 1.45; }",
    "  h1 { font-size: 1.4rem; margin-bottom: 0.5rem; }",
    "  p { margin: 0.75rem 0; }",
    "  .pending { color: #555; }",
    "  .error { color: #b00020; }",
    "  code { background: #f4f4f4; padding: 0.1rem 0.3rem; border-radius: 3px;",
    "         font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;",
    "         font-size: 0.95em; }",
    "  .spinner { display: inline-block; width: 1rem; height: 1rem;",
    "             border: 2px solid #ccc; border-top-color: #555;",
    "             border-radius: 50%; animation: spin 0.9s linear infinite;",
    "             margin-right: 0.4rem; vertical-align: -0.15rem; }",
    "  @keyframes spin { to { transform: rotate(360deg); } }",
    "</style>",
    "</head>",
    "<body>",
  ].join("\n");
}

function chromeClose(): string {
  return "</body></html>";
}

// HTML-escape helpers — apply to ALL caller-provided strings before
// interpolating into templates. Defends against client_name / redirect_uri
// containing < > & " characters even though the daemon controls the
// values today.

export function escapeText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function escapeAttr(s: string): string {
  return escapeText(s).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ---------------------------------------------------------------------
// Surface builders. Each returns just the HTML string; caller writes the
// response code.
// ---------------------------------------------------------------------

export function pendingPage(opts: {
  status_url: string;
  client_name: string;
}): string {
  return [
    chromeOpen({
      title: "Authorizing… — claude-bridge",
      meta_refresh_url: opts.status_url,
      meta_refresh_seconds: 2,
    }),
    `<h1><span class="spinner" aria-hidden="true"></span>Authorizing ${escapeText(opts.client_name)}…</h1>`,
    "<p class=\"pending\">Look for the VS Code window that opened the authorization request. Approve or decline it there.</p>",
    "<p class=\"pending\">This page will refresh automatically.</p>",
    chromeClose(),
  ].join("\n");
}

// CB-DAEMON-LIFECYCLE-FIX (c2): the offline page now distinguishes the two
// states the daemon can actually tell apart, and enumerates the four real
// causes so the operator isn't guessing. `extensionConnected` is true when an
// extension HAS completed the hello handshake with THIS daemon but has no
// trusted/registered workspace (no folder open, or Trust not completed) —
// vs. false when no extension is talking to this daemon at all (not running,
// or — the doubled-daemon split — bound to a DIFFERENT daemon).
export function extensionOfflinePage(extensionConnected = false): string {
  const headline = extensionConnected
    ? "A VS Code window is connected, but no workspace is registered"
    : "No VS Code extension is connected to this daemon";
  const diagnosis = extensionConnected
    ? "<p>An extension IS connected to this daemon, but it has no trusted, registered workspace — so there's nothing to bind. Open a folder in that VS Code window and complete the <strong>Trust</strong> prompt, then try again.</p>"
    : "<p>No VS Code extension has registered with this daemon. Check each likely cause below.</p>";
  return [
    chromeOpen({ title: "Extension offline — claude-bridge" }),
    `<h1 class="error">${headline}</h1>`,
    "<p>This authorization needs a VS Code window with the claude-bridge extension, a folder open, and that folder trusted/registered with the daemon serving this request.</p>",
    diagnosis,
    "<p>Likely causes:</p>",
    "<ul>",
    "<li>No VS Code window with the extension is open.</li>",
    "<li>The window has <strong>no folder</strong> open.</li>",
    "<li>The folder isn't <strong>trusted</strong> yet — complete the Trust prompt in VS Code.</li>",
    "<li>The window is connected to a <strong>different daemon</strong> (a doubled daemon). Run <code>claude-bridge status</code> to see which sessions are connected to this daemon, and the daemon pid shown in the VS Code status-bar tooltip.</li>",
    "</ul>",
    chromeClose(),
  ].join("\n");
}

export function noUnboundWorkspacePage(): string {
  return [
    chromeOpen({ title: "No workspace available — claude-bridge" }),
    "<h1 class=\"error\">No unbound workspace available to bind</h1>",
    "<p>Every connected VS Code window is already bound to a Claude.ai client. A workspace can be bound to one client at a time.</p>",
    "<p>To bind this client, either <strong>unbind</strong> a workspace (from its VS Code status bar) or <strong>open the VS Code window for the workspace you intend to use</strong>, then try the authorization again.</p>",
    chromeClose(),
  ].join("\n");
}

export function ackTimeoutPage(): string {
  return [
    chromeOpen({ title: "Extension not responding — claude-bridge" }),
    "<h1 class=\"error\">VS Code extension didn't respond</h1>",
    "<p>The daemon notified the extension but it didn't acknowledge within 3 seconds. This usually means the extension process is wedged.</p>",
    "<p>Reload the VS Code window (or restart VS Code) and try the authorization again.</p>",
    chromeClose(),
  ].join("\n");
}

export function decisionTimeoutPage(): string {
  return [
    chromeOpen({ title: "Authorization timed out — claude-bridge" }),
    "<h1 class=\"error\">Authorization timed out</h1>",
    "<p>The consent window in VS Code wasn't completed within 30 seconds.</p>",
    "<p>Re-initiate the authorization to try again.</p>",
    chromeClose(),
  ].join("\n");
}

export function denyPage(opts: { denial_kind: "deny" | "dismiss" }): string {
  const headline = opts.denial_kind === "deny"
    ? "Authorization declined"
    : "Authorization cancelled";
  const detail = opts.denial_kind === "deny"
    ? "You chose to decline this authorization request in VS Code."
    : "You dismissed the authorization modal in VS Code without approving.";
  return [
    chromeOpen({ title: `${headline} — claude-bridge` }),
    `<h1 class="error">${escapeText(headline)}</h1>`,
    `<p>${escapeText(detail)}</p>`,
    "<p>If this was a mistake, re-initiate the authorization to try again.</p>",
    chromeClose(),
  ].join("\n");
}

export function notFoundPage(): string {
  return [
    chromeOpen({ title: "Not found — claude-bridge" }),
    "<h1 class=\"error\">Unknown authorization request</h1>",
    "<p>This authorization request has expired or was never valid. Start a new authorization flow from your MCP client.</p>",
    chromeClose(),
  ].join("\n");
}
