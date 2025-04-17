const fs = require("fs");
const express = require("express");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const bodyParser = require("body-parser");
const cors = require("cors");

const app = express();
const PORT = 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static("public"));

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: ["--no-sandbox"],
    executablePath:
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", // adjust as needed
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
const LINKED_NUMBER = "771234567";
const LINKED_CHAT_ID = `94${LINKED_NUMBER}@c.us`;

// In‑memory active sessions
// conversationSessions[localNumber] = { partner, startTime }
let conversationSessions = {};

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

// Message handler
client.on("message", async (message) => {
  // Extract the 9‑digit local number (e.g. "9477...@c.us" → "771234567")
  const fullNumber = message.from.replace(/@c\.us$/, "");
  const senderNumber = fullNumber.slice(-9);

  // 1) Admin commands
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

  // 2) Active 1‑min session?
  const session = conversationSessions[senderNumber];
  if (session) {
    const text = message.body.trim().toLowerCase();

    // 2a) If user wants to end-chat early
    if (text === "end-chat") {
      const partner = session.partner;
      // Notify both sides
      await client.sendMessage(
        `94${senderNumber}@c.us`,
        "Session ended by you"
      );
      await client.sendMessage(
        `94${partner}@c.us`,
        "Session ended by your friend"
      );
      // Clear session
      delete conversationSessions[senderNumber];
      delete conversationSessions[partner];
      console.log(
        `Session between ${senderNumber} and ${partner} ended by user.`
      );
    } else {
      // 2b) Otherwise relay the message
      const partnerChatId = `94${session.partner}@c.us`;
      await client.sendMessage(partnerChatId, message.body);
    }
    return; // done
  }

  // 3) Forward all other messages to admin
  await client.sendMessage(
    LINKED_CHAT_ID,
    `From ${senderNumber}: ${message.body}`
  );

  const users = loadUsers();
  const user = users.find((u) => u.number === senderNumber);

  // 4) "start" command to match
  if (user && user.verified && message.body.trim().toLowerCase() === "start") {
    await message.reply("We will find a friend for you. Wait for a while..");

    const pool = users.filter(
      (u) =>
        u.number !== senderNumber &&
        u.verified &&
        u.gender === user.requestedGender
    );

    if (pool.length) {
      const pick = pool[Math.floor(Math.random() * pool.length)];
      const pickChatId = `94${pick.number}@c.us`;

      await client.sendMessage(
        pickChatId,
        "Hi, One friend is waiting for you."
      );
      console.log(`Matched ${senderNumber} ↔ ${pick.number}`);

      // record session
      const startTime = new Date();
      conversationSessions[senderNumber] = {
        partner: pick.number,
        startTime,
      };
      conversationSessions[pick.number] = {
        partner: senderNumber,
        startTime,
      };

      // log to chats.json
      const chats = loadChats();
      chats.push({
        requestedNumber: senderNumber,
        selectedNumber: pick.number,
        time: startTime.toLocaleString("en-US", {
          timeZone: "Asia/Colombo",
        }),
      });
      saveChats(chats);

      // notify admin
      await client.sendMessage(
        LINKED_CHAT_ID,
        `Match started between ${senderNumber} and ${pick.number}.`
      );

      // schedule automatic end after 1 minute
      setTimeout(async () => {
        const active = conversationSessions[senderNumber];
        if (active && active.partner === pick.number) {
          await client.sendMessage(`94${senderNumber}@c.us`, "session ended");
          await client.sendMessage(`94${pick.number}@c.us`, "session ended");
          delete conversationSessions[senderNumber];
          delete conversationSessions[pick.number];
          console.log(
            `Session between ${senderNumber} and ${pick.number} ended automatically.`
          );
        }
      }, 60 * 1000);
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

  // 6) Log every message
  const now = new Date().toLocaleString("en-US", {
    timeZone: "Asia/Colombo",
  });
  console.log(`${now} | ${message.from}: ${message.body}`);
});

// Start server & WhatsApp client
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
client.initialize();
