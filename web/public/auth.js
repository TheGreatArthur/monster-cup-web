// Login page: Discord (through Supabase, web/discord-auth.js), and the old username + password
// form when the server shows it (PASSWORD_LOGIN=1), or at /?password when it keeps it hidden.
const form = document.getElementById("auth-form");
const errorEl = document.getElementById("error");
const submit = form.querySelector("button[type=submit]");
const password = form.elements.password;
const passwordBox = document.getElementById("password-login");
const askedForPassword = new URLSearchParams(location.search).has("password");
let mode = "login";

async function showMethods() {
  const config = await fetch("/api/auth/config").then((r) => r.json())
    .catch(() => ({ discord: false, password: true, register: true }));
  document.getElementById("discord").hidden = !config.discord;
  passwordBox.hidden = !config.password && !askedForPassword;
  if (askedForPassword) passwordBox.open = true;
  // New accounts come from Discord when the server has it.
  document.querySelector("[data-mode=register]").hidden = !config.register;
  if (!config.discord) {
    // No Discord on this server: the password form is the only way in.
    passwordBox.open = true;
    passwordBox.querySelector("summary").hidden = true;
    document.getElementById("lead").textContent = "Log in to play and pick up your save.";
  }
  if (!config.discord && !config.password) errorEl.textContent = "Login is not set up on this server.";
}

for (const tab of document.querySelectorAll("[data-mode]")) {
  tab.addEventListener("click", () => {
    mode = tab.dataset.mode;
    for (const t of document.querySelectorAll("[data-mode]")) {
      t.setAttribute("aria-selected", String(t === tab));
    }
    submit.textContent = mode === "login" ? "Log in" : "Create my account";
    password.autocomplete = mode === "login" ? "current-password" : "new-password";
    errorEl.textContent = "";
  });
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorEl.textContent = "";
  submit.disabled = true;
  try {
    const res = await fetch(`/api/${mode}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: form.elements.username.value, password: password.value }),
    });
    if (res.ok) {
      location.href = "/play";
      return;
    }
    errorEl.textContent = (await res.json()).error ?? "Unexpected error.";
  } catch {
    errorEl.textContent = "Server unreachable.";
  } finally {
    submit.disabled = false;
  }
});

showMethods();
