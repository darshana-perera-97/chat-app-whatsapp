const fs = require("fs");
const express = require("express");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const bodyParser = require("body-parser");
const cors = require("cors");

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static("public"));

// WhatsApp Client Setup
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: ["--no-sandbox"],
    executablePath:
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", // adjust for your OS/environment
  },
});

client.on("qr", (qr) => {
  console.log("Scan the QR code below to connect:");
  qrcode.generate(qr, { small: true });
});

client.on("ready", () => {
  console.log("WhatsApp client is ready and connected!");
});

// Linked WhatsApp number (admin) configuration
const LINKED_NUMBER = "771234567";
const LINKED_CHAT_ID = `94${LINKED_NUMBER}@c.us`;

// In‑memory mapping of active sessions
// conversationSessions[number] = { partner, startTime }
let conversationSessions = {};

// --- Load & Save Users ---
const usersFilePath = "users.json";
const loadUsers = () => {
  if (!fs.existsSync(usersFilePath)) return [];
  const data = fs.readFileSync(usersFilePath, "utf-8");
  return data ? JSON.parse(data) : [];
};
const saveUsers = (users) => {
  fs.writeFileSync(usersFilePath, JSON.stringify(users, null, 2));
};

// --- Load & Save Chats ---
const chatsFilePath = "chats.json";
const loadChats = () => {
  if (!fs.existsSync(chatsFilePath)) return [];
  const data = fs.readFileSync(chatsFilePath, "utf-8");
  return data ? JSON.parse(data) : [];
};
const saveChats = (chats) => {
  fs.writeFileSync(chatsFilePath, JSON.stringify(chats, null, 2));
};

// Generate random OTP
const generateOTP = () =>
  Math.floor(100000 + Math.random() * 900000).toString();

// Send OTP via WhatsApp
const sendOTP = async (number, otp) => {
  const chatId = `94${number}@c.us`;
  const message = `You have successfully been added to the system. To continue, type the OTP below and send it back to us.\n\n${otp}`;
  await client.sendMessage(chatId, message);
};

// API to register user and send OTP
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

  if (!number || !/^7\d{8}$/.test(number)) {
    return res.status(400).json({ error: "Invalid phone number format." });
  }
  if (
    !name ||
    !age ||
    !gender ||
    !requestedGender ||
    !Array.isArray(charactors) ||
    charactors.length === 0 ||
    charactors.length > 5 ||
    !requestedAgeRange ||
    typeof requestedAgeRange.start !== "number" ||
    typeof requestedAgeRange.end !== "number" ||
    !Array.isArray(requestedCharactors) ||
    requestedCharactors.length === 0 ||
    requestedCharactors.length > 5
  ) {
    return res.status(400).json({ error: "Incomplete or invalid user data." });
  }

  const users = loadUsers();
  if (users.find((u) => u.number === number)) {
    return res.status(400).json({ error: "User already exists." });
  }

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
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to send OTP via WhatsApp." });
  }
});

// WhatsApp message handler
client.on("message", async (message) => {
  const senderNumber = message.from.replace("@c.us", "").slice(-9);

  // 1) Admin forwarding
  if (message.from === LINKED_CHAT_ID) {
    if (message.body.toLowerCase().startsWith("to:")) {
      const parts = message.body.split(" ");
      const targetNumber = parts[0].split(":")[1];
      if (!targetNumber || !/^7\d{8}$/.test(targetNumber)) {
        await client.sendMessage(
          LINKED_CHAT_ID,
          "Invalid target number format. Use 7XXXXXXXX."
        );
      } else {
        const adminMsg = parts.slice(1).join(" ");
        await client.sendMessage(`94${targetNumber}@c.us`, adminMsg);
        console.log(`Admin → ${targetNumber}: ${adminMsg}`);
      }
    } else {
      console.log("Admin message received with no TO: command.");
    }
    return;
  }

  // 2) Forward all non-admin messages to admin
  await client.sendMessage(
    LINKED_CHAT_ID,
    `From ${senderNumber}: ${message.body}`
  );

  const users = loadUsers();
  const user = users.find((u) => u.number === senderNumber);

  // 3) "start" command to match
  if (user && user.verified && message.body.trim().toLowerCase() === "start") {
    await message.reply("We will find a friend for you. Wait for a while..");

    const potential = users.filter(
      (u) =>
        u.number !== senderNumber &&
        u.verified &&
        u.gender === user.requestedGender
    );

    if (potential.length > 0) {
      const pick = potential[Math.floor(Math.random() * potential.length)];
      const pickChatId = `94${pick.number}@c.us`;

      // notify match
      await client.sendMessage(
        pickChatId,
        "Hi, One friend is waiting for you."
      );
      console.log(`Matched ${senderNumber} ↔ ${pick.number}`);

      // store session
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

      // schedule session end in 1 minute
      setTimeout(async () => {
        // still active?
        const sess = conversationSessions[senderNumber];
        if (sess && sess.partner === pick.number) {
          const msgToA = `94${senderNumber}@c.us`;
          const msgToB = `94${pick.number}@c.us`;
          await client.sendMessage(msgToA, "session ended");
          await client.sendMessage(msgToB, "session ended");
          // clear session
          delete conversationSessions[senderNumber];
          delete conversationSessions[pick.number];
          console.log(
            `Session between ${senderNumber} and ${pick.number} ended after 1 minute.`
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

  // 4) OTP verification
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

  // log every message
  const now = new Date().toLocaleString("en-US", { timeZone: "Asia/Colombo" });
  console.log(`${now} | ${message.from}: ${message.body}`);
});

// Start server & client
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
client.initialize();
