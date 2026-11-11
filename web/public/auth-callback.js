// Supabase sends the browser back here after Discord, with the access token in the URL fragment
// (or an error). The token goes to the server, which checks it and opens our own session.
const status = document.getElementById("status");
const errorEl = document.getElementById("error");
const retry = document.getElementById("retry");

function fail(message) {
  status.textContent = "Discord login did not work.";
  errorEl.textContent = message;
  retry.hidden = false;
}

async function main() {
  const hash = new URLSearchParams(location.hash.slice(1));
  const query = new URLSearchParams(location.search);
  // Never leave the token in the address bar or the history.
  history.replaceState(null, "", "/auth/callback");
  const error = hash.get("error_description") ?? query.get("error_description") ?? hash.get("error") ?? query.get("error");
  if (error) return fail(error.replaceAll("+", " "));
  const accessToken = hash.get("access_token");
  if (!accessToken) return fail("Discord sent no login. Please try again.");
  try {
    const res = await fetch("/api/auth/discord", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessToken }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return fail(body.error ?? "Unexpected error.");
    status.textContent = body.linked ? "Discord linked. Back to the game..." : "Logged in. Loading the game...";
    location.replace("/play");
  } catch {
    fail("Server unreachable.");
  }
}

main();
