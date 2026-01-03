const WebSocket = require("ws");
const net = require("net");

// Use Render's assigned port, or 8080 locally
const port = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port });

const clients = new Set();

wss.on("connection", (socket) => {
  console.log("Client connected");
  clients.add(socket);

  // Initial status message
  socket.send(JSON.stringify({
    type: "status",
    message: "connected",
  }));

  let ttSocket = null; // TeamTalk TCP socket

  // Per-connection TeamTalk state (for this WebSocket client)
  const ttState = {
    channels: {},          // chanid -> { id, name, path, parentId }
    users: {},             // userid -> { id, nickname, username, channelId }
    currentChannelPath: "/", // Default to root
  };

  function sendToClient(obj) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(obj));
    }
  }

  function broadcastChannels() {
    const channels = Object.values(ttState.channels);
    sendToClient({ type: "tt-channel-list", channels });
  }

  function broadcastUsers() {
    const users = Object.values(ttState.users);
    sendToClient({ type: "tt-user-list", users });
  }

  socket.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      console.error("Invalid JSON:", raw.toString());
      return;
    }

    console.log("Received:", data);

    // -------------------------------
    // 1. HANDSHAKE HANDLER
    // -------------------------------
    if (data.type === "handshake") {
      console.log("Handshake received from client:", data);

      socket.clientInfo = {
        id: data.client || "unknown-client",
        protocol: data.protocol || 1,
        capabilities: data.capabilities || [],
        connectedAt: Date.now()
      };

      sendToClient({
        type: "handshake-ack",
        status: "ok",
        protocol: 1,
        message: "Handshake received. Ready for TeamTalk connection.",
        serverTime: Date.now()
      });

      return;
    }

    // -------------------------------
    // 2. PING / PONG
    // -------------------------------
    if (data.type === "ping") {
      sendToClient({
        type: "pong",
        sentAt: data.timestamp || Date.now(),
        serverTime: Date.now()
      });
      return;
    }

    // -------------------------------
    // 3. TEAMTALK HANDSHAKE REQUEST
    // -------------------------------
    if (data.type === "tt-handshake") {
      console.log("TeamTalk handshake request:", data);

      const { ttHost, ttPort, username, password, channel } = data;

      sendToClient({
        type: "tt-status",
        phase: "received",
        message: "TeamTalk handshake request received. Connecting..."
      });

      // Create TCP connection to TeamTalk server
      ttSocket = net.createConnection({ host: ttHost, port: ttPort }, () => {
        console.log("Connected to TeamTalk server");

        sendToClient({
          type: "tt-status",
          phase: "connected",
          message: "Connected to TeamTalk server."
        });

        // CORRECT TeamTalk login text command
        const loginCmd =
          `login username="${username}" ` +
          `password="${password}" ` +
          `nickname="${username}" ` +
          `protocol="5.14" ` +
          `clientname="ConnectingWorlds"\r\n`;

        ttSocket.write(loginCmd);

        sendToClient({
          type: "tt-status",
          phase: "login-sent",
          message: "Sent TeamTalk login packet."
        });

        // Auto-join root channel if requested or default
// Auto-join root channel by ID
ttState.currentChannelPath = "/";
ttState.currentChannelId = 1;
const joinCmd = `join chanid=1\r\n`;
ttSocket.write(joinCmd);
// Start keepalive timer (ping every 30 seconds)
ttState.keepalive = setInterval(() => {
  if (ttSocket && !ttSocket.destroyed) {
    ttSocket.write("ping\r\n");
  }
}, 30000);
});   // <-- THIS closes the net.createConnection callback

// Handle TeamTalk server messages
ttSocket.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        console.log("TeamTalk server says:", text);

        // Send raw text for debugging
        sendToClient({
          type: "tt-status",
          phase: "server-message",
          raw: text
        });

        // Parse line-by-line
        const lines = text.split("\r\n").filter(l => l.trim().length > 0);
        for (const line of lines) {
          parseTeamTalkLine(line, ttState, sendToClient);
        }

        // After processing, broadcast updated channels/users
        broadcastChannels();
        broadcastUsers();
      });

ttSocket.on("close", () => {
  console.log("TeamTalk connection closed");

  // Stop keepalive timer
  if (ttState.keepalive) {
    clearInterval(ttState.keepalive);
    ttState.keepalive = null;
  }

  sendToClient({
    type: "tt-status",
    phase: "disconnected",
    message: "Disconnected from TeamTalk server."
  });
});

ttSocket.on("error", (err) => {
  console.error("TeamTalk socket error:", err);

  // Stop keepalive timer
  if (ttState.keepalive) {
    clearInterval(ttState.keepalive);
    ttState.keepalive = null;
  }

  sendToClient({
    type: "tt-status",
    phase: "error",
    message: err.message
  });
});

      return;
    }

    // -------------------------------
    // 4. TEAMTALK CHAT FROM UI
    // -------------------------------
    if (data.type === "tt-chat") {
      if (!ttSocket) {
        sendToClient({
          type: "tt-status",
          phase: "error",
          message: "Not connected to TeamTalk."
        });
        return;
      }

      const text = (data.text || "").trim();
      if (!text) return;

      const targetChannel = data.channel || ttState.currentChannelPath || "/";

      // Simple escaping of double quotes in text
      const safeText = text.replace(/"/g, '\\"');

      const cmd = `chanmsg channel="${targetChannel}" text="${safeText}"\r\n`;
      ttSocket.write(cmd);

      // Echo locally as chat
      sendToClient({
        type: "tt-chat",
        from: "admin",
        channel: targetChannel,
        text
      });

      return;
    }

    // -------------------------------
    // 5. TEAMTALK JOIN REQUEST FROM UI
    // -------------------------------
    if (data.type === "tt-join") {
      if (!ttSocket) {
        sendToClient({
          type: "tt-status",
          phase: "error",
          message: "Not connected to TeamTalk."
        });
        return;
      }

const channelPath = data.channel || "/";
ttState.currentChannelPath = channelPath;

// Find channel ID by path
let chanidToJoin = 1;
for (const ch of Object.values(ttState.channels)) {
  if (ch.path === channelPath) {
    chanidToJoin = ch.id;
    break;
  }
}

ttState.currentChannelId = chanidToJoin;

const joinCmd = `join chanid=${chanidToJoin}\r\n`;
ttSocket.write(joinCmd);

      sendToClient({
        type: "tt-status",
        phase: "join-sent",
        message: `Requested join of channel ${channelPath}`
      });

      return;
    }

    // -------------------------------
    // 6. CHAT / AAC TEXT BROADCAST (WEB-ONLY)
    // -------------------------------
    if (data.type === "aac_text" || data.type === "chat") {
      for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({
            type: "chat",
            from: data.from || (socket.clientInfo?.id || "web"),
            text: data.text,
          }));
        }
      }
      return;
    }
  });

  // -------------------------------
  // SOCKET CLOSE / ERROR HANDLING
  // -------------------------------
  socket.on("close", () => {
    console.log("Client disconnected");
    clients.delete(socket);
    if (ttSocket) {
      ttSocket.destroy();
      ttSocket = null;
    }
  });

  socket.on("error", (err) => {
    console.error("Socket error:", err);
    clients.delete(socket);
    if (ttSocket) {
      ttSocket.destroy();
      ttSocket = null;
    }
  });
});

console.log(`Connecting Worlds bridge server listening on port ${port}`);


// ==============================
// TeamTalk line parser
// ==============================
function parseTeamTalkLine(line, ttState, sendToClient) {
  // Helper: key="value"
  function extractFieldQuoted(name) {
    const regex = new RegExp(`${name}="([^"]*)"`);
    const m = line.match(regex);
    return m ? m[1] : null;
  }

  // Helper: key=123
  function extractFieldNumber(name) {
    const regex = new RegExp(`${name}=([0-9]+)`);
    const m = line.match(regex);
    return m ? parseInt(m[1], 10) : null;
  }

  if (line.startsWith("addchannel ")) {
    const chanid = extractFieldNumber("chanid");
    const parentid = extractFieldNumber("parentid");
    const path = extractFieldQuoted("channel") || "/";
    const name = extractFieldQuoted("name") || path;

    if (chanid != null) {
      ttState.channels[chanid] = {
        id: chanid,
        name,
        path,
        parentId: parentid
      };
    }
    return;
  }

  if (line.startsWith("adduser ")) {
    const userid = extractFieldNumber("userid");
    if (userid == null) return;

    const nickname = extractFieldQuoted("nickname") ||
                     extractFieldQuoted("username") ||
                     "user";
    const username = extractFieldQuoted("username") || "user";
    const chanid = extractFieldNumber("chanid") ?? 0;

    ttState.users[userid] = {
      id: userid,
      nickname,
      username,
      channelId: chanid
    };
    return;
  }

  if (line.startsWith("userupdate ")) {
    const userid = extractFieldNumber("userid");
    if (userid != null && ttState.users[userid]) {
      const chanid = extractFieldNumber("chanid");
      if (chanid != null) {
        ttState.users[userid].channelId = chanid;
      }
    }
    return;
  }

  if (line.startsWith("removeuser ")) {
    const userid = extractFieldNumber("userid");
    if (userid != null) {
      delete ttState.users[userid];
    }
    return;
  }

  if (line.startsWith("chanmsg ")) {
    const fromNick = extractFieldQuoted("nickname") ||
                     extractFieldQuoted("username") ||
                     "someone";
    const channel = extractFieldQuoted("channel") || "/";
    const text = extractFieldQuoted("text") || "";

    sendToClient({
      type: "tt-chat",
      from: fromNick,
      channel,
      text
    });
    return;
  }

  if (line.startsWith("joined ")) {
    const channel = extractFieldQuoted("channel") || "/";
    ttState.currentChannelPath = channel;
    sendToClient({
      type: "tt-current-channel",
      channel
    });
    return;
  }
}


