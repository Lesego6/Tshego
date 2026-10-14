
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  let token = localStorage.getItem("letterus-love-token") || "";
  let account = null;
  let messages = [];
  let sendingNote = false;
  let sendingHug = false;
  let refreshPromise = null;

  const loveSocket =
    typeof socket !== "undefined"
      ? socket
      : typeof io === "function"
        ? io()
        : null;

  function show(id, visible) {
    const element = $(id);
    if (element) element.hidden = !visible;
  }

  function feedback(message) {
    const element = $("love-feedback");
    if (element) element.textContent = message;
  }

  function identifySocket() {
    if (loveSocket && loveSocket.connected) {
      loveSocket.emit("love:identify", token || "");
    }
  }

  async function api(path, method = "GET", body) {
    const response = await fetch("/api/love" + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token
          ? { Authorization: `Bearer ${token}` }
          : {})
      },
      ...(body === undefined
        ? {}
        : { body: JSON.stringify(body) })
    });

    let data;

    try {
      data = await response.json();
    } catch {
      throw new Error("Unable to read the server response.");
    }

    if (!response.ok) {
      const error = new Error(
        data.error || "Something went wrong."
      );

      error.status = response.status;
      throw error;
    }

    return data;
  }

  function clearSession(message = "Signed out ♡") {
    token = "";
    account = null;
    messages = [];

    localStorage.removeItem("letterus-love-token");

    identifySocket();

    show("love-letter", false);
    show("love-hug-toast", false);

    renderAccount();

    const mailbox = $("love-messages");
    if (mailbox) mailbox.replaceChildren();

    const unread = $("love-unread");
    if (unread) unread.textContent = "";

    feedback(message);
  }

  function renderAccount() {
    show("love-auth", !account);
    show("love-account", Boolean(account));

    show(
      "love-pair",
      Boolean(account && !account.partnerName)
    );

    show(
      "love-actions",
      Boolean(account && account.partnerName)
    );

    if (!account) return;

    $("love-greeting").textContent =
      `Welcome, ${account.displayName} ♡`;

    $("love-invite").textContent =
      account.inviteCode || "";

    $("love-partner").textContent =
      account.partnerName
        ? `Connected with ${account.partnerName} ♡`
        : "Give your person your invitation code, or enter theirs below.";
  }

  async function refresh() {
    if (!token) {
      account = null;
      renderAccount();
      return;
    }

    if (refreshPromise) return refreshPromise;

    const currentToken = token;

    refreshPromise = (async () => {
      try {
        const user = await api("/me");

        if (currentToken !== token) return;

        account = user;
        renderAccount();

        if (account.partnerName) {
          const savedMessages = await api("/messages");

          if (currentToken !== token) return;

          messages = savedMessages;
          renderMessages();
        } else {
          messages = [];
        }

        identifySocket();
      } catch (error) {
        if (currentToken !== token) return;

        if (error.status === 401) {
          clearSession("Your session expired. Please sign in again.");
        } else {
          feedback(error.message);
        }
      }
    })();

    try {
      await refreshPromise;
    } finally {
      refreshPromise = null;
    }
  }

  function renderMessages() {
    const mailbox = $("love-messages");
    mailbox.replaceChildren();

    const received = messages.filter(
      (message) => !message.mine
    );

    const unreadCount = received.filter(
      (message) => !message.opened_at
    ).length;

    $("love-unread").textContent =
      unreadCount > 0
        ? `${unreadCount} unopened ♡`
        : "";

    if (messages.length === 0) {
      mailbox.textContent =
        "Your little mailbox is empty for now ♡";
      return;
    }

    messages.forEach((message) => {
      const button = document.createElement("button");

      button.type = "button";
      button.className = "love-message";

      const sender = message.mine
        ? "You sent"
        : `${message.sender_name} sent`;

      const type =
        message.kind === "note"
          ? "a Love Note"
          : "a Hug";

      const icon =
        message.kind === "note" ? "✉" : "♡";

      const date = new Date(
        message.created_at
      ).toLocaleDateString();

      const unread =
        !message.mine && !message.opened_at
          ? " • Unopened"
          : "";

      button.textContent =
        `${icon} ${sender} ${type} · ${date}${unread}`;

      button.addEventListener("click", () => {
        openMessage(message);
      });

      mailbox.appendChild(button);
    });
  }

  function displayHug(senderName, isMine = false) {
    const text = isMine
      ? "You sent the biggest, warmest hug! ♡"
      : `${senderName} is sending you the biggest, warmest hug! ♡`;

    $("love-hug-text").textContent = text;

    // Your duck image is already included in index.html:
    // <img src="/img/hug.png" class="hug-image">

    const hugImage = document.querySelector(
      "#love-hug-toast .hug-image"
    );

    if (hugImage) {
      hugImage.src = "/img/hug.png";
      hugImage.alt = "A cute duck sending a warm hug";
    }

    show("love-hug-back", !isMine);
    show("love-hug-toast", true);
  }

  async function openMessage(message) {
    if (message.kind === "hug") {
      displayHug(message.sender_name, message.mine);
    } else {
      $("love-letter-title").textContent =
        message.mine
          ? "A letter from you ♡"
          : `A letter from ${message.sender_name} ♡`;

      $("love-letter-body").textContent =
        message.body || "";

      show("love-letter", true);
    }

    if (!message.mine && !message.opened_at) {
      try {
        await api(
          `/messages/${encodeURIComponent(message.id)}/open`,
          "POST"
        );

        message.opened_at = new Date().toISOString();

        renderMessages();
      } catch (error) {
        feedback(error.message);
      }
    }
  }

  $("love-auth-form").addEventListener(
    "submit",
    async (event) => {
      event.preventDefault();

      const register = $("love-register").checked;

      const username =
        $("love-username").value.trim();

      const password =
        $("love-password").value;

      const displayName =
        $("love-display").value.trim();

      const submitButton = $(
        "love-auth-form"
      ).querySelector('button[type="submit"]');

      submitButton.disabled = true;

      try {
        const data = await api(
          register ? "/register" : "/login",
          "POST",
          {
            username,
            password,
            displayName
          }
        );

        token = data.token;

        localStorage.setItem(
          "letterus-love-token",
          token
        );

        $("love-password").value = "";

        identifySocket();

        feedback("Welcome to Our Forever Space ♡");

        await refresh();
      } catch (error) {
        feedback(error.message);
      } finally {
        submitButton.disabled = false;
      }
    }
  );

  $("love-register").addEventListener(
    "change",
    () => {
      const registering = $("love-register").checked;

      show("love-display-wrap", registering);

      $("love-display").required = registering;

      $("love-password").autocomplete =
        registering
          ? "new-password"
          : "current-password";
    }
  );

  $("love-logout").addEventListener(
    "click",
    async () => {
      const logoutButton = $("love-logout");

      logoutButton.disabled = true;

      try {
        await api("/logout", "POST");
        clearSession("Signed out. See you soon ♡");
      } catch (error) {
        feedback(
          `Couldn't sign out on the server: ${error.message}`
        );
      } finally {
        logoutButton.disabled = false;
      }
    }
  );

  $("love-pair-button").addEventListener(
    "click",
    async () => {
      const code =
        $("love-pair-code").value.trim();

      if (!code) {
        feedback("Enter your person's invitation code ♡");
        return;
      }

      const button = $("love-pair-button");
      button.disabled = true;

      try {
        await api("/pair", "POST", { code });

        $("love-pair-code").value = "";

        feedback("Your hearts are connected ♡");

        await refresh();
      } catch (error) {
        feedback(error.message);
      } finally {
        button.disabled = false;
      }
    }
  );

  $("love-send-note").addEventListener(
    "click",
    async () => {
      if (sendingNote) return;

      const body =
        $("love-note-text").value.trim();

      if (!body) {
        feedback("Write a little something first ♡");
        return;
      }

      if (body.length > 1000) {
        feedback("Love Notes can have up to 1,000 characters.");
        return;
      }

      sendingNote = true;
      $("love-send-note").disabled = true;

      try {
        await api("/messages", "POST", {
          kind: "note",
          body
        });

        $("love-note-text").value = "";

        feedback("Your Love Note is on its way ♡");

        await refresh();
      } catch (error) {
        feedback(error.message);
      } finally {
        sendingNote = false;
        $("love-send-note").disabled = false;
      }
    }
  );

  async function sendHug() {
    if (sendingHug) return;

    sendingHug = true;

    $("love-send-hug").disabled = true;
    $("love-hug-back").disabled = true;

    try {
      await api("/messages", "POST", {
        kind: "hug"
      });

      feedback("A big warm hug has been sent ♡");

      await refresh();
    } catch (error) {
      feedback(error.message);
    } finally {
      sendingHug = false;

      $("love-send-hug").disabled = false;
      $("love-hug-back").disabled = false;
    }
  }

  $("love-send-hug").addEventListener(
    "click",
    sendHug
  );

  $("love-hug-back").addEventListener(
    "click",
    async () => {
      await sendHug();

      if (!sendingHug) {
        show("love-hug-toast", false);
      }
    }
  );

  $("love-hug-dismiss").addEventListener(
    "click",
    () => {
      show("love-hug-toast", false);
    }
  );

  $("love-letter-close").addEventListener(
    "click",
    () => {
      show("love-letter", false);
    }
  );

  // Real-time Socket.IO events

  if (loveSocket) {
    loveSocket.on("connect", () => {
      identifySocket();
    });

    loveSocket.on("love:refresh", () => {
      refresh();
    });

    loveSocket.on("love:new", (data) => {
      if (!token) return;

      const { kind, senderName } = data;

      if (kind === "hug") {
        displayHug(senderName);
      } else if (kind === "note") {
        feedback(
          `${senderName} left you a little Love Note ♡`
        );
      }

      refresh();
    });

    identifySocket();
  } else {
    console.error(
      "LetterUs: Socket.IO was not initialized."
    );
  }

  // Restore account after refreshing the page

  renderAccount();
  refresh();
})();
