const fs = require("fs");
const express = require("express");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const bodyParser = require("body-parser");
const cors = require("cors");

const app = express();
const PORT = 5020;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static("public"));

// --- cross‑platform Chrome/Chromium resolution ---
const chromePaths = {
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ],
  linux: [
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
  ],
  darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
};

function resolveChromeExecutable() {
  const plat = process.platform;
  const candidates = chromePaths[plat] || [];
  for (let p of candidates) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch (e) {
      // not found or not executable
    }
  }
  throw new Error(
    `Cannot find Chrome executable on platform "${plat}". Tried:\n${candidates.join(
      "\n"
    )}`
  );
}

// allow override via env var
const customChromePath = process.env.CHROME_PATH;
const executablePath = customChromePath || resolveChromeExecutable();
// --------------------------------------------------

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: ["--no-sandbox"],
    executablePath,
  },
});

client.on("qr", (qr) => {
  console.log("Scan the QR code below to connect:");
  qrcode.generate(qr, { small: true });
});

client.on("ready", () => {
  console.log("WhatsApp client is ready and connected!");
});

// Admin config
const LINKED_NUMBER = "752689058";
const LINKED_CHAT_ID = `94${LINKED_NUMBER}@c.us`;

// In‑memory active sessions
let conversationSessions = {};
let handshakeSessions = {};

// schedule warnings and session end/extension
function scheduleSessionEnd(requester, partner) {
  [requester, partner].forEach((id) => {
    if (conversationSessions[id]) {
      conversationSessions[id].waitingForExtension = false;
      conversationSessions[id].extensionApproved = false;
    }
  });

  // warning at 35s
  setTimeout(async () => {
    const sess = conversationSessions[requester];
    if (sess && sess.partner === partner) {
      [requester, partner].forEach((id) => {
        conversationSessions[id].waitingForExtension = true;
      });
      await client.sendMessage(
        `94${requester}@c.us`,
        "Session is about to end. If you want to continue, type yes."
      );
      await client.sendMessage(
        `94${partner}@c.us`,
        "Session is about to end. If you want to continue, type yes."
      );
    }
  }, 35 * 1000);

  // end or extend at 60s
  setTimeout(async () => {
    const sess = conversationSessions[requester];
    if (sess && sess.partner === partner) {
      const approved =
        conversationSessions[requester].extensionApproved ||
        conversationSessions[partner].extensionApproved;

      if (approved) {
        [requester, partner].forEach((id) => {
          delete conversationSessions[id].waitingForExtension;
          delete conversationSessions[id].extensionApproved;
        });
        await client.sendMessage(
          `94${requester}@c.us`,
          "✅ Session extended for another minute."
        );
        await client.sendMessage(
          `94${partner}@c.us`,
          "✅ Session extended for another minute."
        );
        console.log(`Session between ${requester} and ${partner} extended.`);
        scheduleSessionEnd(requester, partner);
      } else {
        await client.sendMessage(`94${requester}@c.us`, "session ended");
        await client.sendMessage(`94${partner}@c.us`, "session ended");
        delete conversationSessions[requester];
        delete conversationSessions[partner];
        console.log(`Session between ${requester} and ${partner} ended.`);
      }
    }
  }, 60 * 1000);
}

// Persistence helpers
const usersFile = "users.json";
const chatsFile = "chats.json";

const loadUsers = () => {
  if (!fs.existsSync(usersFile)) return [];
  return JSON.parse(fs.readFileSync(usersFile, "utf-8") || "[]");
};
const saveUsers = (u) =>
  fs.writeFileSync(usersFile, JSON.stringify(u, null, 2));

const loadChats = () => {
  if (!fs.existsSync(chatsFile)) return [];
  return JSON.parse(fs.readFileSync(chatsFile, "utf-8") || "[]");
};
const saveChats = (c) =>
  fs.writeFileSync(chatsFile, JSON.stringify(c, null, 2));

const generateOTP = () =>
  Math.floor(100000 + Math.random() * 900000).toString();

const sendOTP = async (number, otp) => {
  const chatId = `94${number}@c.us`;
  const msg = `You have successfully been added to the system. To continue, type the OTP below and send it back to us.\n\n${otp}`;
  await client.sendMessage(chatId, msg);
};

// Registration endpoint
app.post("/api/add-user", async (req, res) => {
  const {
    number,
    name,
    nickname,
    age,
    gender,
    charactors,
    requestedAgeRange,
    requestedGender,
    requestedCharactors,
  } = req.body;

  if (!number || !/^7\d{8}$/.test(number))
    return res.status(400).json({ error: "Invalid phone number format." });

  if (
    !nickname ||
    !name ||
    !age ||
    !gender ||
    !requestedGender ||
    !Array.isArray(charactors) ||
    charactors.length < 1 ||
    charactors.length > 5 ||
    !requestedAgeRange ||
    typeof requestedAgeRange.start !== "number" ||
    typeof requestedAgeRange.end !== "number" ||
    !Array.isArray(requestedCharactors) ||
    requestedCharactors.length < 1 ||
    requestedCharactors.length > 5
  )
    return res.status(400).json({ error: "Incomplete or invalid user data." });

  const users = loadUsers();
  if (users.some((u) => u.number === number))
    return res.status(400).json({ error: "User already exists." });

  const otp = generateOTP();
  users.push({
    number,
    name,
    nickname,
    age,
    gender,
    charactors,
    requestedAgeRange,
    requestedGender,
    requestedCharactors,
    verified: false,
    otp,
  });
  saveUsers(users);

  try {
    await sendOTP(number, otp);
    res.status(200).json({ message: "User added successfully, OTP sent!" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to send OTP via WhatsApp." });
  }
});

client.on("message", async (message) => {
  const fullNumber = message.from.replace(/@c\.us$/, "");
  const senderNumber = fullNumber.slice(-9);

  // 0) handshake acceptance
  for (const key in handshakeSessions) {
    const hs = handshakeSessions[key];
    if (senderNumber === hs.partner) {
      const users = loadUsers();
      const requesterUser = users.find((u) => u.number === hs.requester);
      const partnerUser = users.find((u) => u.number === hs.partner);
      const requesterChatId = `94${hs.requester}@c.us`;
      const partnerChatId = message.from;
      const startTime = new Date();

      await client.sendMessage(
        requesterChatId,
        `${partnerUser.nickname} is ready to chat with you`
      );
      await client.sendMessage(
        partnerChatId,
        `You are now connected with ${requesterUser.nickname}`
      );

      conversationSessions[hs.requester] = { partner: hs.partner, startTime };
      conversationSessions[hs.partner] = { partner: hs.requester, startTime };

      const chats = loadChats();
      chats.push({
        requestedNumber: hs.requester,
        selectedNumber: hs.partner,
        time: startTime.toLocaleString("en-US", { timeZone: "Asia/Colombo" }),
      });
      saveChats(chats);

      await client.sendMessage(
        LINKED_CHAT_ID,
        `Match started between ${hs.requester} ↔ ${hs.partner}.`
      );
      console.log(`Match confirmed: ${hs.requester} ↔ ${hs.partner}`);

      scheduleSessionEnd(hs.requester, hs.partner);
      delete handshakeSessions[key];
      return;
    }
  }

  // 1) admin commands
  if (message.from === LINKED_CHAT_ID) {
    const body = message.body.trim();
    if (body.toLowerCase().startsWith("to:")) {
      const [_, rest] = body.split(":", 2);
      const [target, ...parts] = rest.trim().split(" ");
      if (!/^7\d{8}$/.test(target)) {
        await client.sendMessage(
          LINKED_CHAT_ID,
          "Invalid target number format. Use 7XXXXXXXX."
        );
      } else {
        const adminMsg = parts.join(" ");
        await client.sendMessage(`94${target}@c.us`, adminMsg);
        console.log(`Admin → ${target}: ${adminMsg}`);
      }
    }
    return;
  }

  // 2) active session?
  const session = conversationSessions[senderNumber];
  if (session) {
    const partner = session.partner;
    const text = message.body.trim().toLowerCase();

    if (session.waitingForExtension && text === "yes") {
      [senderNumber, partner].forEach((id) => {
        if (conversationSessions[id]) {
          conversationSessions[id].extensionApproved = true;
          conversationSessions[id].waitingForExtension = false;
        }
      });
      console.log(
        `Extension approved by ${senderNumber} for session ${senderNumber}↔${partner}`
      );
      return;
    }

    if (text === "end") {
      await client.sendMessage(
        `94${senderNumber}@c.us`,
        "Session ended by you"
      );
      await client.sendMessage(
        `94${partner}@c.us`,
        "Session ended by your friend"
      );
      delete conversationSessions[senderNumber];
      delete conversationSessions[partner];
      console.log(
        `Session between ${senderNumber} and ${partner} ended by user.`
      );
    } else {
      await client.sendMessage(`94${partner}@c.us`, message.body);
    }
    return;
  }

  // 3) forward to admin
  await client.sendMessage(
    LINKED_CHAT_ID,
    `From ${senderNumber}: ${message.body}`
  );

  const users = loadUsers();
  const user = users.find((u) => u.number === senderNumber);

  // 4) "start" command
  if (user && user.verified && message.body.trim().toLowerCase() === "start") {
    await message.reply("We will find a friend for you. Please wait...");
    const pool = users.filter(
      (u) =>
        u.number !== senderNumber &&
        u.verified &&
        u.gender === user.requestedGender
    );
    if (pool.length) {
      const pick = pool[Math.floor(Math.random() * pool.length)];
      const requesterChatId = `94${senderNumber}@c.us`;
      const pickChatId = `94${pick.number}@c.us`;
      const key = `${senderNumber}-${pick.number}`;

      handshakeSessions[key] = {
        requester: senderNumber,
        partner: pick.number,
      };

      await client.sendMessage(
        pickChatId,
        `${user.nickname} is requesting to have a chat with you. Please reply within 30 seconds to accept.`
      );
      console.log(`Handshake request sent: ${senderNumber} → ${pick.number}`);

      setTimeout(async () => {
        if (handshakeSessions[key]) {
          delete handshakeSessions[key];
          await client.sendMessage(
            requesterChatId,
            `${pick.nickname} did not respond to your request. You can try again by sending "start".`
          );
          console.log(`No handshake response from ${pick.number}; cleaned up.`);
        }
      }, 30 * 1000);
    } else {
      await message.reply(
        "No matching friend found at the moment. Try again later."
      );
      console.log(`No match for ${senderNumber}`);
    }
    return;
  }

  // 5) OTP verification
  if (user && !user.verified) {
    if (message.body.trim() === user.otp) {
      user.verified = true;
      delete user.otp;
      saveUsers(users);
      await message.reply("✅ Your number has been successfully verified!");
      console.log(`${senderNumber} verified.`);
    } else {
      await message.reply("❌ Incorrect OTP. Please try again.");
      console.log(`${senderNumber} OTP mismatch.`);
    }
  } else if (user && user.verified) {
    await message.reply("ℹ️ Your number is already verified.");
  } else {
    await message.reply(
      "⚠️ Your number is not registered. Please register first."
    );
  }

  // 6) log every message
  const now = new Date().toLocaleString("en-US", { timeZone: "Asia/Colombo" });
  console.log(`${now} | ${message.from}: ${message.body}`);
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
client.initialize();
