const http = require("http");
const { Server } = require("socket.io");

const server = http.createServer((req, res) => {
  // Health check endpoint for Render
  if (req.url === "/" || req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Rat Slap server is running");
    return;
  }
  res.writeHead(404);
  res.end();
});

const io = new Server(server, {
  cors: {
    origin: [
      "https://ratslap.com",
      "https://www.ratslap.com",
      "http://ratslap.com",
      "http://www.ratslap.com",
      "http://localhost:8000",
      "http://127.0.0.1:8000",
      "https://www.perplexity.ai",
      "https://sites.pplx.app",
    ],
    methods: ["GET", "POST"],
  },
});

/* ─────────────── Card helpers ─────────────── */
const SUITS = ["♠", "♥", "♦", "♣"];
const RANKS = ["2","3","4","5","6","7","8","9","10","J","Q","K","A"];

function createDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ rank: r, suit: s });
  return d;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function isFaceCard(card) {
  return ["J","Q","K","A"].includes(card.rank);
}

function faceFlips(card) {
  const m = { J: 1, Q: 2, K: 3, A: 4 };
  return m[card.rank] || 0;
}

/* ─────────────── Slap detection ─────────────── */
function checkSlap(pile) {
  if (pile.length < 2) return null;
  const top = pile[pile.length - 1];
  const sec = pile[pile.length - 2];
  if (top.rank === sec.rank) return "pair";
  if (pile.length >= 3) {
    const third = pile[pile.length - 3];
    if (top.rank === third.rank) return "sandwich";
  }
  return null;
}

/* ─────────────── Rooms / lobbies ─────────────── */
const rooms = new Map();

function generateCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return rooms.has(code) ? generateCode() : code;
}

function broadcastState(room) {
  const r = rooms.get(room);
  if (!r) return;
  for (const p of r.players) {
    const s = io.sockets.sockets.get(p.id);
    if (!s) continue;
    s.emit("gameState", buildStateFor(r, p.id));
  }
  for (const sp of r.spectators || []) {
    const s = io.sockets.sockets.get(sp);
    if (s) s.emit("gameState", buildStateFor(r, null));
  }
}

function buildStateFor(r, myId) {
  const pileTop = r.pile.length > 0 ? r.pile[r.pile.length - 1] : null;
  const pileSecond = r.pile.length > 1 ? r.pile[r.pile.length - 2] : null;
  const pileThird = r.pile.length > 2 ? r.pile[r.pile.length - 3] : null;

  return {
    phase: r.phase,
    roomCode: r.code,
    players: r.players.map((p, i) => ({
      name: p.name,
      cardCount: p.deck.length,
      isMe: p.id === myId,
      index: i,
      isOut: p.deck.length === 0 && r.phase === "playing",
      connected: !!io.sockets.sockets.get(p.id),
    })),
    currentPlayer: r.currentPlayer,
    pile: {
      count: r.pile.length,
      top: pileTop,
      second: pileSecond,
      third: pileThird,
    },
    challenge: r.challenge ? {
      active: true,
      remainingFlips: r.challenge.remainingFlips,
      challengerIndex: r.challenge.challengerIndex,
      responderIndex: r.challenge.responderIndex,
    } : null,
    canSlap: checkSlap(r.pile) !== null,
    winner: r.winner || null,
    lastAction: r.lastAction || null,
    hostId: r.hostId,
  };
}

function nextAlivePlayer(r, fromIndex) {
  let idx = (fromIndex + 1) % r.players.length;
  let loops = 0;
  while (r.players[idx].deck.length === 0 && loops < r.players.length) {
    idx = (idx + 1) % r.players.length;
    loops++;
  }
  return idx;
}

function alivePlayers(r) {
  return r.players.filter(p => p.deck.length > 0);
}

function checkGameOver(r) {
  const alive = alivePlayers(r);
  if (alive.length <= 1 && r.phase === "playing") {
    r.phase = "gameover";
    r.winner = alive.length === 1 ? alive[0].name : "Nobody";
    broadcastState(r.code);
    return true;
  }
  return false;
}

function playerIndex(r, id) {
  return r.players.findIndex(p => p.id === id);
}

/* ─────────────── Socket events ─────────────── */
io.on("connection", (socket) => {
  let currentRoom = null;

  socket.on("createRoom", ({ name }) => {
    const code = generateCode();
    const room = {
      code,
      phase: "lobby",
      hostId: socket.id,
      players: [{ id: socket.id, name: name || "Player 1", deck: [] }],
      spectators: [],
      pile: [],
      currentPlayer: 0,
      challenge: null,
      winner: null,
      lastAction: null,
    };
    rooms.set(code, room);
    socket.join(code);
    currentRoom = code;
    socket.emit("roomJoined", { code, name: room.players[0].name });
    broadcastState(code);
  });

  socket.on("joinRoom", ({ code, name }) => {
    const r = rooms.get(code);
    if (!r) return socket.emit("error", { msg: "Room not found" });
    if (r.phase !== "lobby") return socket.emit("error", { msg: "Game already in progress" });
    if (r.players.length >= 4) return socket.emit("error", { msg: "Room is full (4 max)" });
    if (r.players.find(p => p.id === socket.id)) return;

    const playerName = name || `Player ${r.players.length + 1}`;
    r.players.push({ id: socket.id, name: playerName, deck: [] });
    socket.join(code);
    currentRoom = code;
    socket.emit("roomJoined", { code, name: playerName });
    broadcastState(code);
  });

  socket.on("startGame", () => {
    const r = rooms.get(currentRoom);
    if (!r || r.phase !== "lobby") return;
    if (socket.id !== r.hostId) return socket.emit("error", { msg: "Only the host can start" });
    if (r.players.length < 2) return socket.emit("error", { msg: "Need at least 2 players" });

    const deck = shuffle(createDeck());
    const numPlayers = r.players.length;
    for (let i = 0; i < deck.length; i++) {
      r.players[i % numPlayers].deck.push(deck[i]);
    }

    r.phase = "playing";
    r.currentPlayer = 0;
    r.pile = [];
    r.challenge = null;
    r.winner = null;
    r.lastAction = { type: "gameStarted" };
    broadcastState(currentRoom);
  });

  socket.on("flipCard", () => {
    const r = rooms.get(currentRoom);
    if (!r || r.phase !== "playing") return;

    const pIdx = playerIndex(r, socket.id);
    if (pIdx === -1) return;
    const player = r.players[pIdx];

    if (r.challenge) {
      if (pIdx !== r.challenge.responderIndex) return;
    } else {
      if (pIdx !== r.currentPlayer) return;
    }

    if (player.deck.length === 0) return;

    const card = player.deck.shift();
    r.pile.push(card);

    r.lastAction = { type: "flip", playerIndex: pIdx, playerName: player.name, card };

    if (r.challenge) {
      if (isFaceCard(card)) {
        r.challenge = {
          challengerIndex: pIdx,
          responderIndex: nextAlivePlayer(r, pIdx),
          remainingFlips: faceFlips(card),
        };
      } else {
        r.challenge.remainingFlips--;
        if (r.challenge.remainingFlips <= 0) {
          const challenger = r.players[r.challenge.challengerIndex];
          challenger.deck.push(...r.pile);
          r.lastAction = {
            type: "challengeWon",
            playerIndex: r.challenge.challengerIndex,
            playerName: challenger.name,
            pileSize: r.pile.length,
          };
          r.pile = [];
          r.currentPlayer = r.challenge.challengerIndex;
          r.challenge = null;
          if (checkGameOver(r)) return;
          broadcastState(currentRoom);
          return;
        }
      }
    } else {
      if (isFaceCard(card)) {
        r.challenge = {
          challengerIndex: pIdx,
          responderIndex: nextAlivePlayer(r, pIdx),
          remainingFlips: faceFlips(card),
        };
      } else {
        r.currentPlayer = nextAlivePlayer(r, pIdx);
      }
    }

    if (r.challenge && r.players[r.challenge.responderIndex].deck.length === 0) {
      const challenger = r.players[r.challenge.challengerIndex];
      challenger.deck.push(...r.pile);
      r.lastAction = {
        type: "challengeWon",
        playerIndex: r.challenge.challengerIndex,
        playerName: challenger.name,
        pileSize: r.pile.length,
      };
      r.pile = [];
      r.currentPlayer = r.challenge.challengerIndex;
      r.challenge = null;
    }

    if (checkGameOver(r)) return;
    broadcastState(currentRoom);
  });

  socket.on("slap", () => {
    const r = rooms.get(currentRoom);
    if (!r || r.phase !== "playing") return;

    const pIdx = playerIndex(r, socket.id);
    if (pIdx === -1) return;

    const slapType = checkSlap(r.pile);

    if (slapType) {
      const player = r.players[pIdx];
      player.deck.push(...r.pile);
      r.lastAction = {
        type: "slap",
        slapType,
        playerIndex: pIdx,
        playerName: player.name,
        pileSize: r.pile.length,
      };
      r.pile = [];
      r.challenge = null;
      r.currentPlayer = pIdx;
      if (checkGameOver(r)) return;
      broadcastState(currentRoom);
    } else {
      const player = r.players[pIdx];
      if (player.deck.length > 0) {
        const burned = player.deck.shift();
        r.pile.unshift(burned);
        r.lastAction = {
          type: "badSlap",
          playerIndex: pIdx,
          playerName: player.name,
        };
        if (checkGameOver(r)) return;
        broadcastState(currentRoom);
      }
    }
  });

  socket.on("playAgain", () => {
    const r = rooms.get(currentRoom);
    if (!r) return;
    if (socket.id !== r.hostId) return;
    r.phase = "lobby";
    r.pile = [];
    r.challenge = null;
    r.winner = null;
    r.currentPlayer = 0;
    r.lastAction = null;
    for (const p of r.players) p.deck = [];
    broadcastState(currentRoom);
  });

  socket.on("disconnect", () => {
    if (!currentRoom) return;
    const r = rooms.get(currentRoom);
    if (!r) return;

    if (r.phase === "lobby") {
      r.players = r.players.filter(p => p.id !== socket.id);
      if (r.players.length === 0) {
        rooms.delete(currentRoom);
        return;
      }
      if (r.hostId === socket.id) r.hostId = r.players[0].id;
    }
    broadcastState(currentRoom);
  });
});

// Clean up empty rooms periodically
setInterval(() => {
  for (const [code, room] of rooms) {
    const hasConnected = room.players.some(p => io.sockets.sockets.get(p.id));
    if (!hasConnected) rooms.delete(code);
  }
}, 60000);

const PORT = process.env.PORT || 10000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Rat Slap server listening on port ${PORT}`);
});
